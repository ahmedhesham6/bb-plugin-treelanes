import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { skillId } from "./task-kinds";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** The plugins whose data `bb treelanes import` copies once. */
export const IMPORT_SOURCES = ["workflow-board", "worktree-sidebar"] as const;

export const importMigration = `CREATE TABLE plugin_import (
  id INTEGER PRIMARY KEY CHECK(id = 1), imported_at INTEGER NOT NULL, summary_json TEXT NOT NULL
)`;

const SKIPPED_TABLES = new Set(["_bb_migrations", "plugin_import"]);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Copy the old plugins' tables into this plugin's database in one transaction.
 * Only columns both sides have are copied, so an older source schema works.
 * A second run does nothing; a destination with data is refused.
 */
export function importOldData(db: Db, dataDir: string, skills: readonly string[]) {
  const done = db.prepare("SELECT imported_at, summary_json FROM plugin_import").get() as
    { imported_at: number; summary_json: string } | undefined;
  if (done) return { alreadyImported: true, importedAt: done.imported_at, copied: JSON.parse(done.summary_json) };
  const sources = IMPORT_SOURCES.map(id => ({ id, file: join(dataDir, "plugins", id, "data.db") }))
    .filter(source => existsSync(source.file));
  if (!sources.length) throw new Error(`Found no data to import from ${IMPORT_SOURCES.join(" or ")}.`);
  const tables = (schema: string) => (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]).map(row => row.name).filter(name => !SKIPPED_TABLES.has(name));
  const columns = (schema: string, table: string) =>
    (db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as { name: string }[]).map(row => row.name);
  const attached: string[] = [];
  try {
    for (const [index, source] of sources.entries()) {
      const schema = `source_${index}`;
      db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(source.file);
      attached.push(schema);
    }
    const local = new Set(tables("main"));
    const plan = sources.flatMap((source, index) => tables(attached[index]!).filter(table => local.has(table)).map(table => {
      const shared = new Set(columns("main", table));
      return { source: source.id, schema: attached[index]!, table, columns: columns(attached[index]!, table).filter(column => shared.has(column)).map(quote).join(", ") };
    }));
    const copied = db.transaction(() => {
      const filled = [...local].filter(table => db.prepare(`SELECT 1 FROM main.${quote(table)} LIMIT 1`).get());
      if (filled.length) throw new Error(`Treelanes already has data in ${filled.join(", ")}. Import only into a new install.`);
      const summary: Record<string, Record<string, number>> = {};
      for (const item of plan) {
        const result = db.prepare(`INSERT INTO main.${quote(item.table)} (${item.columns}) SELECT ${item.columns} FROM ${item.schema}.${quote(item.table)}`).run();
        (summary[item.source] ??= {})[item.table] = result.changes;
      }
      const ids = new Map(skills.map(name => [skillId(name, IMPORT_SOURCES[0]), skillId(name)]));
      for (const table of local) {
        for (const column of columns("main", table).filter(name => ["context_json", "execution_json", "prepared_json"].includes(name))) {
          const rows = db.prepare(`SELECT rowid, ${quote(column)} AS json FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`).all() as { rowid: number; json: string }[];
          const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE rowid = ?`);
          for (const row of rows) {
            const json = JSON.stringify(JSON.parse(row.json, (key, value) =>
              key === "modelOverrideReason" ? undefined : typeof value === "string" ? ids.get(value) ?? value : value));
            update.run(json, row.rowid);
          }
        }
      }
      db.prepare("INSERT INTO plugin_import VALUES (1, ?, ?)").run(Date.now(), JSON.stringify(summary));
      return summary;
    })();
    return { alreadyImported: false, copied };
  } finally {
    for (const schema of attached) db.exec(`DETACH DATABASE ${schema}`);
  }
}

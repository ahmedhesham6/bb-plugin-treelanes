// Sidebar backend: lifecycle, manual thread order, main threads and titles.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { groupDefinitions, groupStore, type MainThread } from "./group-store";
import { automaticTitles, type TitleChoice } from "./automatic-titles";
import { childVisibility } from "./child-visibility";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Appended to the plugin's single migration list. */
export const sidebarMigrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS thread_order (
     thread_id   TEXT PRIMARY KEY,
     sort_order  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
];

export interface StoredLifecycleRow {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  settled_at: number | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
}

export interface StoredOrderRow {
  threadId: string;
  sortOrder: number;
}

interface OrderDbRow {
  thread_id: string;
  sort_order: number;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });

export const sidebarRpcContract = defineRpcContract({
  ...groupDefinitions,
  listTitles: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          original: z.string(),
          generated: z.string(),
        }),
      ),
    }),
  },
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          settledAt: z.number().nullable(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  listOrder: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({ threadId: z.string(), sortOrder: z.number().int() }),
      ),
    }),
  },
  saveOrder: {
    input: z.object({
      threadIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(1_000)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "Thread ids must be unique",
        }),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  settle: {
    input: threadIdSchema.extend({ includeWorktree: z.boolean().optional() }),
    output: z.object({ ok: z.boolean() }),
  },
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  unsnooze: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";
export const ORDER_CHANNEL = "order";

export function sidebar(bb: BbPluginApi, db: Db, deps: {
  preferredMains(): MainThread[];
  titleChoice(): TitleChoice | null;
}) {
  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, snoozed_until, snoozed_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    }));

  const readOrder = (): StoredOrderRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, sort_order
             FROM thread_order
            ORDER BY sort_order ASC, thread_id ASC`,
        )
        .all() as OrderDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      sortOrder: row.sort_order,
    }));

  const saveOrder = db.transaction((threadIds: readonly string[]) => {
    const statement = db.prepare(
      `INSERT INTO thread_order (thread_id, sort_order, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         sort_order = excluded.sort_order,
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    threadIds.forEach((threadId, index) => statement.run(threadId, index, now));
  });

  const write = (row: StoredLifecycleRow): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at`,
    ).run(row.threadId, row.settledAt, row.snoozedUntil, row.snoozedAt);
  };

  const clear = (threadId: string): void => {
    db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(
      threadId,
    );
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  const groups = groupStore(bb, db, deps.preferredMains);
  const titles = automaticTitles(bb, db, deps.titleChoice);
  childVisibility(bb);

  /** Sidebar CLI commands; null for a command the sidebar does not own. */
  async function cli(argv: string[]) {
    const [command] = argv;
    if (command === "main") {
      const [, projectId, environmentId, threadId] = argv;
      if (!projectId || !environmentId || !threadId)
        return {
          exitCode: 2,
          stderr: "Give project, environment, and thread IDs.\n",
        };
      const state = await groups.listGroups();
      const expectedThreadId =
        state.mains.find(
          (r) =>
            r.projectId === projectId && r.environmentId === environmentId,
        )?.threadId ?? null;
      return {
        exitCode: 0,
        stdout:
          JSON.stringify(
            await groups.saveMain({
              projectId,
              environmentId,
              threadId,
              expectedThreadId,
            }),
          ) + "\n",
      };
    }
    const result =
      command === "titles"
        ? await titles.status()
        : command === "generate-titles"
          ? await titles.run()
          : command === "list-main"
            ? await groups.listGroups()
            : null;
    return result ? { exitCode: 0, stdout: JSON.stringify(result) + "\n" } : null;
  }
  async function requireParkable(threadId: string, includeWorktree = false) {
    const thread = await bb.sdk.threads.get({ threadId });
    const targets: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
    for (let offset = 0; ; offset += 200) {
      const page = await bb.sdk.threads.list({
        projectId: thread.projectId,
        archived: false,
        includeHidden: false,
        limit: 200,
        offset,
      });
      targets.push(
        ...page.filter((t) =>
          t.projectId === thread.projectId &&
          !t.archivedAt && !t.deletedAt && t.visibility !== "hidden" &&
          (t.id === threadId ||
            (includeWorktree && thread.environmentId !== null &&
              t.environmentId === thread.environmentId)),
        ),
      );
      if (page.length < 200 || (!includeWorktree && targets.length)) break;
    }
    const root = targets.find((t) => t.id === threadId);
    if (!root) throw new Error("This thread is unavailable.");
    if (
      includeWorktree &&
      !["managed-worktree", "unmanaged-worktree"].includes(root.environmentWorkspaceDisplayKind)
    )
      throw new Error("This thread is not in a Git worktree.");
    if (targets.some((t) =>
      t.hasPendingInteraction ||
      ["active", "pending", "starting", "stopping"].includes(t.status) ||
      Object.values(t.activity).some((n) => n > 0),
    ))
      throw new Error("A thread has live work or needs input.");
    return targets.map((t) => t.id);
  }
  async function settle({ threadId, includeWorktree }: { threadId: string; includeWorktree?: boolean }) {
    const threadIds = await requireParkable(threadId, includeWorktree);
    // Settling clears any snooze: they are two answers to the same
    // question, and holding both would make the shelf order ambiguous.
    const settledAt = Date.now();
    db.transaction(() => {
      for (const id of threadIds)
        write({ threadId: id, settledAt, snoozedUntil: null, snoozedAt: null });
    })();
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
    return { ok: true };
  }
  bb.rpc.register(sidebarRpcContract, {
    ...groups,
    async listTitles() {
      return titles.list();
    },
    async listLifecycle() {
      return { rows: readAll() };
    },
    async listOrder() {
      return { rows: readOrder() };
    },
    async saveOrder({ threadIds }) {
      saveOrder(threadIds);
      bb.realtime.publish(ORDER_CHANNEL, {});
      return { ok: true };
    },
    settle,
    async unsettle({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil }) {
      await requireParkable(threadId);
      const now = Date.now();
      write({
        threadId,
        settledAt: null,
        snoozedUntil,
        snoozedAt: now,
      });
      bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
    db.prepare(`DELETE FROM thread_order WHERE thread_id = ?`).run(thread.id);
    bb.realtime.publish(ORDER_CHANNEL, { threadId: thread.id });
  });
  return { lifecycle: readAll, settle, cli, titles };
}

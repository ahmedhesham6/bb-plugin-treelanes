import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { kindTemplate, skillId } from "./task-kinds";
import { taskContextSchema } from "./stage-evidence";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const thread = {
  ...makeThreadResponse({ id: "thread-one", projectId: "project-one", environmentId: "env-one" }),
  environmentName: "feature-tree", environmentBranchName: "feat/tree",
  environmentWorkspaceDisplayKind: "managed-worktree" as const,
  activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeGoalCount: 0 },
};

/** Old plugin databases as those plugins wrote them; the board one predates later columns. */
function oldData() {
  const dataDir = mkdtempSync(join(tmpdir(), "treelanes-import-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const open = (id: string) => {
    mkdirSync(join(dataDir, "plugins", id), { recursive: true });
    return new Database(join(dataDir, "plugins", id, "data.db"));
  };
  const board = open("workflow-board");
  board.exec(`CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, hash TEXT);
    INSERT INTO _bb_migrations VALUES (0, 'old');
    CREATE TABLE worktree_cards (environment_id TEXT PRIMARY KEY, stage TEXT NOT NULL, note TEXT, updated_at INTEGER NOT NULL);
    INSERT INTO worktree_cards VALUES ('env-one', 'quality', 'Imported note', 42);`);
  board.close();
  const sidebar = open("worktree-sidebar");
  sidebar.exec(`CREATE TABLE thread_lifecycle (thread_id TEXT PRIMARY KEY, settled_at INTEGER, snoozed_until INTEGER, snoozed_at INTEGER);
    INSERT INTO thread_lifecycle VALUES ('thread-two', 100, NULL, NULL);
    CREATE TABLE worktree_mains (project_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(project_id, environment_id));
    INSERT INTO worktree_mains VALUES ('project-one', 'env-one', 'thread-one');
    CREATE TABLE retired_state (id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL);
    INSERT INTO retired_state VALUES (1, '{}');`);
  sidebar.close();
  return { dataDir, open };
}

async function start(dataDir: string) {
  const host = createFakePluginHost({ pluginId: "treelanes", dataDir, sdk: { threads: {
    list: async () => [thread] as never, get: async () => thread as never,
  }, projects: { list: async () => [] } } });
  cleanup.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  return { ...host.harness, db: host.bb.storage.database() };
}

describe("bb treelanes import", () => {
  it("keeps an old Saved Task readable and moves its skill IDs to Treelanes", async () => {
    const { dataDir, open } = oldData();
    const task = { outcome: "Build the change", scope: ["src/a.ts"], decisions: [], requiredChecks: ["npm test"],
      allowedActions: ["Edit and test"], kind: "feature", setup: { summary: "Build and check", steps:
        kindTemplate({ kind: "feature" }).map(({ skills, ...step }) => ({ ...step, execution: {
          providerId: "test-provider", model: "test-model", reasoningLevel: "high", reason: "Fits the task",
          modelOverrideReason: "Use the old preference override",
          skills: step.id === "build" ? [skillId("tdd", "workflow-board")] : [],
        } })),
      } };
    const board = open("workflow-board");
    board.exec("CREATE TABLE worktree_task_contexts (environment_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, context_json TEXT NOT NULL)");
    board.prepare("INSERT INTO worktree_task_contexts VALUES (?, ?, ?)").run("env-one", 3, JSON.stringify(task));
    board.close();
    const h = await start(dataDir);
    expect((await h.behavior.runCli(["import"])).exitCode).toBe(0);
    const row = h.db.prepare("SELECT revision, context_json FROM worktree_task_contexts WHERE environment_id = 'env-one'").get() as { revision: number; context_json: string };
    const imported = taskContextSchema.parse(JSON.parse(row.context_json));
    expect(row.revision).toBe(3);
    expect(imported.outcome).toBe(task.outcome);
    expect(imported.allowedActions).toEqual(task.allowedActions);
    expect(imported.setup!.steps[0]!.execution.skills).toEqual([skillId("tdd")]);
    expect(imported.setup!.steps[0]!.execution).not.toHaveProperty("modelOverrideReason");
    const unchanged = open("workflow-board");
    expect(unchanged.prepare("SELECT context_json FROM worktree_task_contexts").get()).toEqual({ context_json: JSON.stringify(task) });
    unchanged.close();
  });

  it("rolls back every copied table if a saved task contains invalid JSON", async () => {
    const { dataDir, open } = oldData();
    const board = open("workflow-board");
    board.exec(`CREATE TABLE worktree_task_contexts (environment_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, context_json TEXT NOT NULL);
      INSERT INTO worktree_task_contexts VALUES ('env-one', 1, '{invalid');`);
    board.close();
    const h = await start(dataDir);
    expect((await h.behavior.runCli(["import"])).exitCode).toBe(1);
    expect(h.db.prepare("SELECT * FROM worktree_cards").all()).toEqual([]);
    expect(h.db.prepare("SELECT * FROM plugin_import").all()).toEqual([]);
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
  });

  it("starts empty, then copies old board and sidebar data once", async () => {
    const { dataDir, open } = oldData();
    const h = await start(dataDir);
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
    expect(await h.behavior.callRpc("getBoard", { projectId: null })).toMatchObject({ cards: [{ environmentId: "env-one", stage: "tickets", note: null }] });

    const first = await h.behavior.runCli(["import"]);
    expect(JSON.parse(first.stdout!)).toEqual({ alreadyImported: false, copied: {
      "workflow-board": { worktree_cards: 1 }, "worktree-sidebar": { thread_lifecycle: 1, worktree_mains: 1 },
    } });
    expect(await h.behavior.callRpc("getBoard", { projectId: null })).toMatchObject({ cards: [{ environmentId: "env-one", stage: "quality", note: "Imported note" }] });
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [{ threadId: "thread-two", settledAt: 100, snoozedUntil: null, snoozedAt: null }] });
    expect(await h.behavior.callRpc("listGroups", {})).toMatchObject({ mains: [{ projectId: "project-one", environmentId: "env-one", threadId: "thread-one" }] });

    const sidebar = open("worktree-sidebar");
    sidebar.exec("INSERT INTO thread_lifecycle VALUES ('thread-three', 200, NULL, NULL)");
    sidebar.close();
    await h.behavior.callRpc("unsettle", { threadId: "thread-two" });
    const second = await h.behavior.runCli(["import"]);
    expect(JSON.parse(second.stdout!)).toMatchObject({ alreadyImported: true });
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
  });

  it("refuses a destination that already has data and copies nothing", async () => {
    const { dataDir } = oldData();
    const h = await start(dataDir);
    await h.behavior.callRpc("saveOrder", { threadIds: ["thread-one"] });
    await h.behavior.callRpc("saveGroupOrder", { groupIds: ["env-one"] });
    const result = await h.behavior.runCli(["import"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/already has data in .*group_order/);
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
    expect(await h.behavior.callRpc("listGroups", {})).toMatchObject({ mains: [] });
  });
});

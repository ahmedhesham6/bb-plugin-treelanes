import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(300);
const main = z.object({ projectId: id, environmentId: id, threadId: id });
export type MainThread = z.infer<typeof main>;
const order = z.object({ groupId: id, sortOrder: z.number().int() });
export const groupDefinitions = {
  listGroups: {
    input: z.object({}),
    output: z.object({
      mains: z.array(main),
      preferred: z.array(main),
      order: z.array(order),
    }),
  },
  saveMain: {
    input: main.extend({ expectedThreadId: id.nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  saveGroupOrder: {
    input: z.object({
      groupIds: z
        .array(id)
        .min(1)
        .max(1000)
        .refine((ids) => new Set(ids).size === ids.length),
    }),
    output: z.object({ ok: z.boolean() }),
  },
};

export function groupStore(
  bb: BbPluginApi,
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  preferredMains: () => MainThread[],
) {
  db.exec(`CREATE TABLE IF NOT EXISTS worktree_mains (
    project_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    PRIMARY KEY(project_id, environment_id));
    CREATE TABLE IF NOT EXISTS group_order (group_id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL)`);
  const readMains = () =>
    z
      .array(main)
      .parse(
        db
          .prepare(
            "SELECT project_id AS projectId, environment_id AS environmentId, thread_id AS threadId FROM worktree_mains",
          )
          .all(),
      );
  return {
    async listGroups() {
      return {
        mains: readMains(),
        // The board's initiating threads.
        preferred: preferredMains(),
        order: z
          .array(order)
          .parse(
            db
              .prepare(
                "SELECT group_id AS groupId, sort_order AS sortOrder FROM group_order",
              )
              .all(),
          ),
      };
    },
    async saveMain(input: z.infer<typeof groupDefinitions.saveMain.input>) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      if (
        thread.projectId !== input.projectId ||
        thread.environmentId !== input.environmentId ||
        thread.archivedAt ||
        thread.deletedAt ||
        thread.visibility === "hidden"
      )
        throw new Error("Choose a visible thread in this worktree.");
      const environment = await bb.sdk.environments.get({
        environmentId: input.environmentId,
      });
      // Match BB's workspace display kind. A managed worktree has this kind
      // before provisioning discovers its Git files.
      if (
        environment.workspaceProvisionType !== "managed-worktree" &&
        environment.isWorktree !== true
      )
        throw new Error("This environment is not a Git worktree.");
      const change = db.transaction(() => {
        const row = db
          .prepare(
            "SELECT thread_id FROM worktree_mains WHERE project_id = ? AND environment_id = ?",
          )
          .get(input.projectId, input.environmentId) as
          { thread_id: string } | undefined;
        if ((row?.thread_id ?? null) !== input.expectedThreadId) return false;
        db.prepare(
          "INSERT INTO worktree_mains VALUES (?,?,?) ON CONFLICT(project_id, environment_id) DO UPDATE SET thread_id=excluded.thread_id",
        ).run(input.projectId, input.environmentId, input.threadId);
        return true;
      });
      const ok = change();
      bb.realtime.publish("groups", {});
      return { ok };
    },
    async saveGroupOrder({
      groupIds,
    }: z.infer<typeof groupDefinitions.saveGroupOrder.input>) {
      db.transaction(() => {
        const put = db.prepare(
          "INSERT INTO group_order VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET sort_order=excluded.sort_order",
        );
        groupIds.forEach((key, index) => put.run(key, index));
      })();
      bb.realtime.publish("groups", {});
      return { ok: true };
    },
  };
}

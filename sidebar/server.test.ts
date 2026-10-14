import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

function lifecycleHost(childStatus = "idle") {
  const rows = ["main", "child", "other"].map((id) => ({
    ...makeThreadResponse({ id, projectId: "p", environmentId: id === "other" ? "elsewhere" : "e" }),
    environmentWorkspaceDisplayKind: "managed-worktree",
    status: id === "child" ? childStatus : "idle",
    hasPendingInteraction: false,
    activity: {},
  }));
  const host = createFakePluginHost({
    pluginId: "treelanes",
    sdk: { threads: {
      get: async ({ threadId }) => rows.find((r) => r.id === threadId)! as never,
      list: async () => rows as never,
    } },
  });
  hosts.push(host);
  plugin(host.bb);
  return host.harness;
}

it("settles a worktree together while a child action affects only that child", async () => {
  const h = lifecycleHost();
  await h.behavior.callRpc("settle", { threadId: "child" });
  const list = () => h.behavior.callRpc("listLifecycle", {}) as Promise<{ rows: { threadId: string; settledAt: number }[] }>;
  expect((await list()).rows.map((r) => r.threadId)).toEqual(["child"]);
  await h.behavior.callRpc("unsettle", { threadId: "child" });
  await h.behavior.callRpc("settle", { threadId: "main", includeWorktree: true });
  const rows = (await list()).rows;
  expect(rows.map((r) => r.threadId).sort()).toEqual(["child", "main"]);
  expect(rows[0].settledAt).toBe(rows[1].settledAt);
});

it("leaves the whole worktree unchanged when a child has live work", async () => {
  const h = lifecycleHost("active");
  await expect(h.behavior.callRpc("settle", {
    threadId: "main", includeWorktree: true,
  })).rejects.toThrow("live work");
  expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
});

describe("manual thread order store", () => {
  it("saves and lists a complete order", async () => {
    const host = createFakePluginHost({ pluginId: "treelanes" });
    hosts.push(host);
    plugin(host.bb);

    await host.harness.behavior.callRpc("saveOrder", {
      threadIds: ["thr_b", "thr_a"],
    });
    const result = (await host.harness.behavior.callRpc("listOrder", {})) as {
      rows: Array<{ threadId: string; sortOrder: number }>;
    };
    expect(result.rows).toEqual([
      { threadId: "thr_b", sortOrder: 0 },
      { threadId: "thr_a", sortOrder: 1 },
    ]);
    expect(host.harness.inspection.realtimeSignals.at(-1)?.channel).toBe(
      "order",
    );
  });

  it("rejects duplicate thread ids", async () => {
    const host = createFakePluginHost({ pluginId: "treelanes" });
    hosts.push(host);
    plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("saveOrder", {
        threadIds: ["thr_a", "thr_a"],
      }),
    ).rejects.toThrow("rpc input validation failed");
  });

  it("clears a deleted thread from the saved order", async () => {
    const host = createFakePluginHost({ pluginId: "treelanes" });
    hosts.push(host);
    plugin(host.bb);
    await host.harness.behavior.callRpc("saveOrder", {
      threadIds: ["thr_a", "thr_b"],
    });
    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: { id: "thr_a" },
    } as never);
    const result = (await host.harness.behavior.callRpc("listOrder", {})) as {
      rows: Array<{ threadId: string }>;
    };
    expect(result.rows.map((row) => row.threadId)).toEqual(["thr_b"]);
  });
});

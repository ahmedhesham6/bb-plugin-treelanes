import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose()));
});
function setup() {
  const host = createFakePluginHost({
    pluginId: "treelanes",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "p",
            environmentId: threadId === "outside" ? "other" : "e",
            visibility: "visible",
          }),
      },
      environments: {
        get: async () => ({ isGitRepo: true, isWorktree: true }) as never,
      },
      plugins: { callRpc: async () => ({ rows: [] }) },
    },
  });
  hosts.push(host);
  plugin(host.bb);
  return host.harness;
}
describe("main-thread storage", () => {
  it("saves the main thread while its managed worktree is being created", async () => {
    const h = setup();
    h.inspection.sdk.stub(
      "environments.get",
      async () =>
        ({
          isGitRepo: false,
          isWorktree: false,
          managed: true,
          workspaceProvisionType: "managed-worktree",
          status: "provisioning",
        }) as never,
    );
    await expect(
      h.behavior.callRpc("saveMain", {
        projectId: "p",
        environmentId: "e",
        threadId: "a",
        expectedThreadId: null,
      }),
    ).resolves.toEqual({ ok: true });
    expect(await h.behavior.callRpc("listGroups", {})).toMatchObject({
      mains: [{ projectId: "p", environmentId: "e", threadId: "a" }],
    });
  });

  it("still refuses a directory that BB does not classify as a worktree", async () => {
    const h = setup();
    h.inspection.sdk.stub(
      "environments.get",
      async () =>
        ({
          isGitRepo: true,
          isWorktree: false,
          workspaceProvisionType: "unmanaged",
          status: "ready",
        }) as never,
    );
    await expect(
      h.behavior.callRpc("saveMain", {
        projectId: "p",
        environmentId: "e",
        threadId: "a",
        expectedThreadId: null,
      }),
    ).rejects.toThrow("not a Git worktree");
    expect(await h.behavior.callRpc("listGroups", {})).toMatchObject({
      mains: [],
    });
  });

  it("validates membership and rejects a stale client choice", async () => {
    const h = setup();
    await expect(
      h.behavior.callRpc("saveMain", {
        projectId: "p",
        environmentId: "e",
        threadId: "outside",
        expectedThreadId: null,
      }),
    ).rejects.toThrow("visible thread");
    expect(
      await h.behavior.callRpc("saveMain", {
        projectId: "p",
        environmentId: "e",
        threadId: "a",
        expectedThreadId: null,
      }),
    ).toEqual({ ok: true });
    expect(
      await h.behavior.callRpc("saveMain", {
        projectId: "p",
        environmentId: "e",
        threadId: "b",
        expectedThreadId: null,
      }),
    ).toEqual({ ok: false });
    expect(await h.behavior.callRpc("listGroups", {})).toMatchObject({
      mains: [{ threadId: "a" }],
    });
    const replacement = await h.lifecycle.reload(plugin);
    hosts.push(replacement);
    expect(
      await replacement.harness.behavior.callRpc("listGroups", {}),
    ).toMatchObject({ mains: [{ threadId: "a" }] });
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(h.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });
});
describe("parking guard", () => {
  it.each([
    "runtime",
    "input",
    "workflow",
    "background",
    "command",
    "plan",
    "goal",
  ])("refuses parking when a thread has %s work", async (reason) => {
    const h = setup();
    const keys = {
      workflow: "activeWorkflowCount",
      background: "activeBackgroundAgentCount",
      command: "activeBackgroundCommandCount",
      plan: "activePlanModeCount",
      goal: "activeGoalCount",
    };
    const activity = {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    };
    if (reason in keys)
      activity[keys[reason as keyof typeof keys] as keyof typeof activity] = 1;
    h.inspection.sdk.stub(
      "threads.list",
      async () =>
        [
          {
            ...makeThreadResponse({
              id: "a",
              projectId: "p",
              status: reason === "runtime" ? "active" : "idle",
            }),
            hasPendingInteraction: reason === "input",
            activity,
          },
        ] as never,
    );
    await expect(
      h.behavior.callRpc("settle", { threadId: "a" }),
    ).rejects.toThrow("live work or needs input");
    await expect(
      h.behavior.callRpc("snooze", {
        threadId: "a",
        snoozedUntil: Date.now() + 60000,
      }),
    ).rejects.toThrow("live work or needs input");
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ThreadEventRow } from "@get-bb/plugin-sdk";
import { createThreadRetry, threadRetryMigration } from "./thread-retry";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function setup() {
  const worker = { ...makeThreadResponse({ id: "worker", status: "error" }), environmentId: "env" };
  const state = { requestId: "failure-1", queued: false, waiting: false, lost: false, eligible: true, reads: 0 };
  const calls: unknown[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "retry-test", sdk: { threads: {
    get: async () => worker,
    events: { list: async () => { state.reads++; return state.requestId ? [{ type: "client/turn/requested", data: { requestId: state.requestId } }] as ThreadEventRow[] : []; } },
    interactions: { list: async () => state.waiting ? [{}] as never[] : [] },
    queuedMessages: { list: async () => state.queued ? [{}] as never[] : [] },
    retry: async request => { calls.push(request); if (state.lost) throw new Error("Response lost");
      return { ok: true, delivery: "sent", turnRequestId: "retry-1", attempt: 2 }; },
  } } });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database(); bb.storage.migrate(db, [threadRetryMigration]);
  const retry = createThreadRetry(bb, db, () => false);
  return { bb, harness, db, worker, state, calls, retry,
    run: (force = false) => retry.retry("worker", "env", "assignment", () => state.eligible, force) };
}

describe("same-thread retry", () => {
  it("claims a specific failed turn once under concurrent requests", async () => {
    const t = setup();
    await Promise.all([t.run(), t.run(), t.run()]);
    expect(t.calls).toEqual([{ threadId: "worker", turnRequestId: "failure-1", reason: "Resume the assigned workflow thread after a failed turn" }]);
  });
  it("keeps an uncertain dispatch claimed after a lost response and module restart", async () => {
    const t = setup(); t.state.lost = true;
    await t.run();
    const next = createThreadRetry(t.bb, t.db, () => false);
    await next.retry("worker", "env", "assignment", () => true, true);
    expect(t.calls).toHaveLength(1);
    expect(next.read("worker")).toMatchObject({ status: "uncertain", error: expect.stringContaining("Response lost") });
  });
  it("keeps backoff and the two-retry limit across module restart", async () => {
    const t = setup(); await t.run(); t.state.requestId = "failure-2";
    await t.run(); expect(t.calls).toHaveLength(1);
    t.db.prepare("UPDATE worktree_thread_retries SET claimed_at = claimed_at - 30001").run();
    const next = createThreadRetry(t.bb, t.db, () => false);
    await next.retry("worker", "env", "assignment", () => true);
    expect(t.calls).toHaveLength(2);
    t.state.requestId = "failure-3";
    await next.retry("worker", "env", "assignment", () => true, true);
    expect(t.calls).toHaveLength(2); expect(next.read("worker")?.status).toBe("blocked");
  });
  it.each(["idle", "active", "starting", "pending", "stopping"] as const)("does not retry a %s thread", async status => {
    const t = setup(); t.worker.status = status; await t.run(true); expect(t.calls).toHaveLength(0);
  });
  it.each(["queued", "waiting"] as const)("does not retry while %s", async flag => {
    const t = setup(); t.state[flag] = true; await t.run(true); expect(t.calls).toHaveLength(0);
  });
  it.each(["archivedAt", "deletedAt"] as const)("does not retry a thread with %s", async field => {
    const t = setup(); t.worker[field] = 1; await t.run(true); expect(t.calls).toHaveLength(0);
  });
  it("requires the same environment and a known turn", async () => {
    const t = setup(); t.worker.environmentId = "other"; await t.run(); expect(t.calls).toHaveLength(0);
    t.worker.environmentId = "env"; t.state.requestId = "";
    await expect(t.run()).rejects.toThrow(/identify the failed turn/); expect(t.calls).toHaveLength(0);
  });
  it("rechecks assignment and pause after asynchronous reads", async () => {
    const t = setup();
    await t.retry.retry("worker", "env", "assignment", () => t.state.reads === 0);
    expect(t.calls).toHaveLength(0);
  });
});

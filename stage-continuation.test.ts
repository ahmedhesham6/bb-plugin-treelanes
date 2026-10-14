import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ThreadEventRow } from "@get-bb/plugin-sdk";
import { createStageContinuation, stageContinuationMigration } from "./stage-continuation";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function fixture() {
  const state = { turn: "end-1", stopped: false, queued: false, waiting: false, lost: false, eligible: true };
  const worker = { ...makeThreadResponse({ id: "child", status: "idle" }), environmentId: "env" };
  const { bb, harness } = createFakePluginHost({ pluginId: "continuation", sdk: { threads: {
    get: async ({ threadId }) => ({ ...worker, id: threadId }),
    events: { list: async ({ threadId }) => [{ id: state.turn, threadId, type: state.stopped ? "system/thread/interrupted" : "turn/completed",
      data: state.stopped ? { reason: "manual-stop" } : { status: "completed" } }] as ThreadEventRow[] },
    queuedMessages: { list: async () => state.queued ? [{}] as never[] : [] },
    interactions: { list: async () => state.waiting ? [{}] as never[] : [] },
    send: async () => { if (state.lost) throw new Error("Response lost"); return { ok: true }; },
  } } });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database(); bb.storage.migrate(db, [stageContinuationMigration]);
  const controller = createStageContinuation(bb, db, () => false);
  return { state, worker, bb, db, harness, controller,
    run: () => controller.resume("child", "env", "quality", "assignment", () => state.eligible),
    calls: () => harness.inspection.sdk.callsTo("threads.send") };
}

describe("durable stage continuation", () => {
  it("allows two distinct continuations per assignment, including after restart", async () => {
    const t = fixture(); await Promise.all([t.run(), t.run()]); expect(t.calls()).toHaveLength(1);
    t.state.turn = "end-2"; await t.run(); expect(t.calls()).toHaveLength(2);
    const next = createStageContinuation(t.bb, t.db, () => false);
    t.state.turn = "end-3"; await next.resume("child", "env", "quality", "assignment", () => true);
    expect(t.calls()).toHaveLength(2);
  });
  it("does not repeat an uncertain send", async () => {
    const t = fixture(); t.state.lost = true; await t.run(); await t.run();
    expect(t.calls()).toHaveLength(1); expect(t.controller.read("assignment")?.status).toBe("uncertain");
  });
  it.each(["stopped", "queued", "waiting"] as const)("respects %s for worker continuation and orchestrator help", async flag => {
    const t = fixture(); t.state[flag] = true; await t.run();
    await t.controller.help("orchestrator", "child", "env", "assignment", "Failed local check", () => true);
    expect(t.calls()).toHaveLength(0);
  });
  it("does not continue active work or a changed assignment", async () => {
    const t = fixture(); t.worker.status = "active"; await t.run();
    t.worker.status = "idle"; t.state.eligible = false; await t.run(); expect(t.calls()).toHaveLength(0);
  });
  it("notifies the existing orchestrator only once for an unchanged blocker", async () => {
    const t = fixture();
    await t.controller.help("orchestrator", "child", "env", "assignment", "Failed local check", () => true);
    await t.controller.help("orchestrator", "child", "env", "assignment", "Failed local check", () => true);
    expect(t.calls()).toHaveLength(1); expect(t.calls()[0]?.[0]).toMatchObject({ threadId: "orchestrator" });
  });
});

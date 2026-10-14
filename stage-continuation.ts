import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DELIVERY_SKILL_INSTRUCTION } from "./stage-prompts";
type Db = ReturnType<BbPluginApi["storage"]["database"]>;
export const stageContinuationMigration = `CREATE TABLE worktree_stage_continuations (
  assignment TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, PRIMARY KEY(thread_id, turn_id)
);`;

// A normal turn end without a receipt is incomplete delivery. A manual stop,
// new user turn, pending input, or uncertain send never permits another send.
export function createStageContinuation(bb: BbPluginApi, db: Db, disposed: () => boolean) {
  const read = (assignment: string) => db.prepare("SELECT status, error FROM worktree_stage_continuations WHERE assignment = ? ORDER BY rowid DESC LIMIT 1")
    .get(assignment) as { status: string; error: string | null } | undefined;
  async function resume(threadId: string, environmentId: string, stage: string, assignment: string, eligible: () => boolean) {
    if (disposed() || !eligible()) return;
    const worker = await bb.sdk.threads.get({ threadId });
    if (!worker || worker.status !== "idle" || worker.archivedAt || worker.deletedAt || worker.environmentId !== environmentId) return;
    if ((await bb.sdk.threads.interactions.list({ threadId })).length || (await bb.sdk.threads.queuedMessages.list({ threadId })).length) return;
    const events = await bb.sdk.threads.events.list({ threadId, types: ["turn/completed", "system/thread/interrupted", "client/turn/requested"], order: "desc", limit: "1" });
    const last = events[0];
    if (!last?.id || last.type !== "turn/completed" || last.data.status !== "completed" || disposed() || !eligible()) return;
    await sendOnce(threadId, last.id, assignment, `${DELIVERY_SKILL_INSTRUCTION}\nContinue this ${stage} step in the same thread; its normal turn ended without a receipt. Read fresh workflow_board_get_context, finish the remaining work, and submit actual check evidence. For a blocker or nextAction, read /delivery's references/recovery.md.`, eligible);
  }

  async function sendOnce(threadId: string, turnId: string, assignment: string, text: string, eligible: () => boolean) {
    if (disposed() || !eligible()) return;
    const claim = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM worktree_stage_continuations WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId)) return false;
      const count = db.prepare("SELECT COUNT(*) AS n FROM worktree_stage_continuations WHERE assignment = ?").get(assignment) as { n: number };
      if (count.n >= 2) return false;
      db.prepare("INSERT INTO worktree_stage_continuations VALUES (?, ?, ?, 'claimed', NULL)").run(assignment, threadId, turnId);
      return true;
    })();
    if (!claim) return;
    try {
      await bb.sdk.threads.send({ threadId, mode: "start", input: [{ type: "text", mentions: [], text }] });
      if (!disposed()) db.prepare("UPDATE worktree_stage_continuations SET status = 'sent' WHERE thread_id = ? AND turn_id = ?").run(threadId, turnId);
    } catch (error) {
      if (!disposed()) db.prepare("UPDATE worktree_stage_continuations SET status = 'uncertain', error = ? WHERE thread_id = ? AND turn_id = ?")
        .run(String(error).slice(0, 1000), threadId, turnId);
    }
  }
  async function help(orchestratorId: string, workerId: string, environmentId: string, assignment: string, reason: string, eligible: () => boolean) {
    if (disposed() || !eligible()) return;
    const coordinator = await bb.sdk.threads.get({ threadId: orchestratorId });
    if (!coordinator || coordinator.archivedAt || coordinator.deletedAt || coordinator.environmentId !== environmentId || coordinator.status !== "idle") return;
    if ((await bb.sdk.threads.interactions.list({ threadId: orchestratorId })).length || (await bb.sdk.threads.queuedMessages.list({ threadId: orchestratorId })).length) return;
    const coordinatorEvents = await bb.sdk.threads.events.list({ threadId: orchestratorId,
      types: ["turn/completed", "system/thread/interrupted", "client/turn/requested"], order: "desc", limit: "1" });
    if (coordinatorEvents[0]?.type === "system/thread/interrupted" ||
        (coordinatorEvents[0]?.type === "turn/completed" && coordinatorEvents[0].data.status === "interrupted")) return;
    const events = await bb.sdk.threads.events.list({ threadId: workerId, types: ["turn/completed", "system/thread/interrupted", "client/turn/requested"], order: "desc", limit: "1" });
    if (events[0]?.type !== "turn/completed" || events[0].data.status !== "completed") return;
    const key = createHash("sha256").update(`${assignment}:${workerId}:${reason}`).digest("hex");
    await sendOnce(orchestratorId, key, `help:${assignment}`,
      `${DELIVERY_SKILL_INSTRUCTION}\nYou are the persistent task orchestrator. This is a child-blocker review; read /delivery's references/orchestration.md. Read fresh workflow_board_get_context and the output of child ${workerId}, then guide that existing child.\nRecorded blocker: ${reason.slice(0, 4096)}`, eligible);
  }
  return { resume, read, help };
}

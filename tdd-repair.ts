import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CompletionEvidence } from "./stage-evidence";
import { DELIVERY_SKILL_INSTRUCTION } from "./stage-prompts";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
type Repair = { key: string; thread_id: string; status: string; recorded_at: number; error: string | null };

export const tddRepairMigration = `CREATE TABLE worktree_tdd_repairs (
  key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL,
  recorded_at INTEGER NOT NULL, error TEXT
);`;

function key(environmentId: string, evidence: CompletionEvidence): string {
  return createHash("sha256").update(JSON.stringify([
    environmentId, evidence.stageUpdatedAt, evidence.taskRevision,
    evidence.workspaceDigest, evidence.nextAction,
  ])).digest("hex");
}

export function createTddRepair(bb: BbPluginApi, db: Db, disposed: () => boolean) {
  const read = (environmentId: string, evidence: CompletionEvidence) =>
    db.prepare("SELECT * FROM worktree_tdd_repairs WHERE key = ?")
      .get(key(environmentId, evidence)) as Repair | undefined;

  function record(environmentId: string, threadId: string, evidence: CompletionEvidence) {
    db.prepare("INSERT OR IGNORE INTO worktree_tdd_repairs VALUES (?, ?, 'pending', ?, NULL)")
      .run(key(environmentId, evidence), threadId, Date.now());
    return read(environmentId, evidence)!;
  }

  function describe(environmentId: string, evidence: CompletionEvidence, live: boolean, paused: boolean, waiting = false) {
    if (!["tdd", "quality", "simplify"].includes(evidence.stage) || !evidence.decisionsResolved) return null;
    const repair = read(environmentId, evidence);
    if (!repair) return null;
    const status = paused ? "paused" : waiting ? "waiting" : live && ["pending", "sent"].includes(repair.status) ? "running" : repair.status;
    const labels: Record<string, string> = {
      pending: "Repair queued", running: `Repairing ${evidence.stage}`, sent: "Repair sent; fresh checks needed",
      claimed: "Repair dispatch needs confirmation", uncertain: "Repair dispatch needs confirmation",
      cancelled: "Repair cancelled", paused: "Repair paused", waiting: "Repair waiting for input",
    };
    return { status: `repair-${status}`, message: `${labels[status] ?? "Stage repair"}: ${repair.error ?? evidence.nextAction}` };
  }

  async function continueRepair(environmentId: string, evidence: CompletionEvidence, eligible: () => boolean) {
    const repair = read(environmentId, evidence);
    if (!repair || repair.status !== "pending" || disposed() || !eligible()) return;
    const threadId = repair.thread_id;
    const worker = await bb.sdk.threads.get({ threadId });
    if (!worker || worker.status !== "idle" || worker.archivedAt || worker.deletedAt || worker.environmentId !== environmentId) return;
    if ((await bb.sdk.threads.interactions.list({ threadId })).length ||
        (await bb.sdk.threads.queuedMessages.list({ threadId })).length) return;
    const events = await bb.sdk.threads.events.list({ threadId,
      types: ["turn/completed", "system/thread/interrupted", "client/turn/requested"], order: "desc", limit: "3" });
    // Only a normal completion of the reporting turn can request a continuation.
    // A stop or a newer user turn cancels the old action, including after reload.
    const latest = events[0];
    if (events.some(event => event.createdAt >= repair.recorded_at &&
        (event.type === "system/thread/interrupted" || event.type === "client/turn/requested" ||
          (event.type === "turn/completed" && event.data.status === "interrupted")))) {
      db.prepare("UPDATE worktree_tdd_repairs SET status = 'cancelled', error = ? WHERE key = ? AND status = 'pending'")
        .run("The thread stopped or received newer work. The previous repair will not restart it.", repair.key);
      return;
    }
    if (latest?.type !== "turn/completed" || latest.data.status !== "completed" || latest.createdAt < repair.recorded_at) return;
    if (disposed() || !eligible()) return;
    const claim = db.prepare("UPDATE worktree_tdd_repairs SET status = 'claimed' WHERE key = ? AND status = 'pending'").run(repair.key);
    if (claim.changes !== 1) return;
    try {
      await bb.sdk.threads.send({ threadId, mode: "start", input: [{ type: "text", mentions: [], text:
        `${DELIVERY_SKILL_INSTRUCTION}\nRead /delivery's references/recovery.md. Continue the saved ${evidence.stage} repair in this thread. Read workflow_board_get_context and confirm ownership, stageUpdatedAt ${evidence.stageUpdatedAt}, and taskRevision ${evidence.taskRevision}.\nNext action: ${evidence.nextAction}\nRerun affected checks and submit fresh actual evidence.`,
      }] });
      if (!disposed()) db.prepare("UPDATE worktree_tdd_repairs SET status = 'sent' WHERE key = ?").run(repair.key);
    } catch (error) {
      // No second send after an uncertain result: core may already have the turn.
      if (!disposed()) db.prepare("UPDATE worktree_tdd_repairs SET status = 'uncertain', error = ? WHERE key = ?")
        .run(`Repair send result is unknown. Inspect the same thread: ${String(error).slice(0, 700)}`, repair.key);
    }
    if (!disposed()) bb.realtime.publish("board-changed", { environmentId });
  }
  return { read, record, describe, continueRepair };
}

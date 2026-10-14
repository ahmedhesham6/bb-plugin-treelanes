import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
export const threadRetryMigration = `CREATE TABLE worktree_thread_retries (
  assignment TEXT NOT NULL, thread_id TEXT NOT NULL, request_id TEXT NOT NULL,
  status TEXT NOT NULL, claimed_at INTEGER NOT NULL, error TEXT,
  PRIMARY KEY(thread_id, request_id)
);`;
type RetryRow = { status: string; claimed_at: number; error: string | null };

// A claim is never sent twice. If the response is lost, core's request log and
// queued messages resolve the next turn; an uncertain call cannot spawn a worker.
export function createThreadRetry(bb: BbPluginApi, db: Db, disposed: () => boolean) {
  const read = (threadId: string, assignment?: string) => db.prepare("SELECT * FROM worktree_thread_retries WHERE thread_id = ? AND (? IS NULL OR assignment = ?) ORDER BY claimed_at DESC, rowid DESC LIMIT 1")
    .get(threadId, assignment ?? null, assignment ?? null) as RetryRow | undefined;
  async function retry(threadId: string, environmentId: string, assignment: string, eligible: () => boolean, force = false) {
    if (disposed() || !eligible()) return;
    const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "1" });
    const event = events[0];
    if (event?.type !== "client/turn/requested" || !event.data.requestId) throw new Error("Cannot identify the failed turn for same-thread retry.");
    const requestId = event.data.requestId;
    const worker = await bb.sdk.threads.get({ threadId });
    if (!worker || worker.deletedAt || worker.archivedAt || worker.environmentId !== environmentId || worker.status !== "error" || ("hasPendingInteraction" in worker && worker.hasPendingInteraction)) return;
    if ((await bb.sdk.threads.interactions.list({ threadId })).length || (await bb.sdk.threads.queuedMessages.list({ threadId })).length) return;
    if (disposed() || !eligible()) return;
    const now = Date.now();
    const claimed = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM worktree_thread_retries WHERE thread_id = ? AND request_id = ?").get(threadId, requestId)) return false;
      const previous = db.prepare("SELECT COUNT(*) AS count, MAX(claimed_at) AS last FROM worktree_thread_retries WHERE assignment = ? AND status != 'blocked'")
        .get(assignment) as { count: number; last: number | null };
      if (previous.count >= 2) {
        db.prepare("INSERT INTO worktree_thread_retries VALUES (?, ?, ?, 'blocked', ?, ?)")
          .run(assignment, threadId, requestId, now, "Same-thread retry limit reached (two retries). Keep this thread and report the failure.");
        return false;
      }
      if (!force && previous.last !== null && previous.last + 30_000 > now) return false;
      db.prepare("INSERT INTO worktree_thread_retries VALUES (?, ?, ?, 'claimed', ?, NULL)").run(assignment, threadId, requestId, now);
      return true;
    })();
    if (!claimed) return;
    try {
      await bb.sdk.threads.retry({ threadId, turnRequestId: requestId, reason: "Resume the assigned workflow thread after a failed turn" });
      if (!disposed()) db.prepare("UPDATE worktree_thread_retries SET status = 'sent' WHERE thread_id = ? AND request_id = ?").run(threadId, requestId);
    } catch (error) {
      if (!disposed()) db.prepare("UPDATE worktree_thread_retries SET status = 'uncertain', error = ? WHERE thread_id = ? AND request_id = ?")
        .run(`Retry response unavailable; inspect this thread before retrying: ${String(error).slice(0, 700)}`, threadId, requestId);
    }
  }
  return { retry, read };
}

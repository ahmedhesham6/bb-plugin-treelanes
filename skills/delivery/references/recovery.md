# Recovery

Keep the assigned thread, scope, stage, and authority. A failed check is work to diagnose, not a new approval gate. Use `/diagnosing-bugs` when the cause is unclear, then the current stage skill for the fix.

## Read or receipt error

Retry a timeout, connection error, or HTTP 502 at most twice with a short delay. Missing, truncated, oversized, or inconsistent evidence remains incomplete. Continue independent authorized work when possible; report the failed operation if it persists.

For stale completion data, read fresh context, confirm this thread still owns the unpaused stage, inspect what changed, and rerun affected checks. Submit fresh evidence. Allow at most two attempts for that error. A changed owner, user pause, missing authority, or exhausted limit requires its stated resolution.

## Check failure or unfinished work

Repair in-scope code, local test setup, and tool input in this worker, then rerun affected checks. The plugin owner permits routine test-seam selection within accepted public interfaces; this grants no new product behavior or authority. Keep stricter task limits. Continue independent work while required decisions or dependencies wait, and keep those items visible.

When yielding with a concrete repair left, submit actual failed evidence through `complete` with `nextAction` naming the change and affected check. The board saves `blockedAttempt` and may continue that action once in this thread after a normal turn end. `recorded: false` is not a Completion Receipt; emit no completion marker. Read fresh context before continuing.

Keep base failures and external limits separate from branch defects. Preserve the raw command status and any saved acceptance criteria. Do not relabel a failed command as passed or repeat unchanged full suites. For PR delivery, once diagnosis proves a base or environment failure, keep the actual status and add `nonTaskFailure: { "kind": "base" | "environment", "diagnosis": "..." }` to that check. Cite the compared base revision and matching failures, or the unavailable dependency and diagnosis. Resubmit fresh evidence; the board can advance with that limit through Quality, Simplify and PR Watch. Never use this field for unknown causes, task defects, open findings or missing human decisions. Keep at least one passing task check. Failed CI still prevents a ready-to-merge claim. If no such diagnosis exists, continue diagnosis in the same thread. The existing orchestrator can inspect it and guide this child. Missing decisions or access remain human steps.

## Different plan or failed runtime turn

Use `workflow_board_recover` with `reason` and `nextAction` only when an in-scope repair needs a different plan. Name the change and the check it can resolve, then end without a marker. The board waits for this worker to become idle and allows at most two plan changes. Pending human decisions cannot use this path.

A failed runtime turn uses the board's Same-thread Retry, with two attempts per assignment. It keeps the thread, model, revision, and stage. A normal turn that omits a receipt may get a bounded continuation in that thread. Pauses, manual stops, pending input, queued work, and recorded blockers keep their own rules. An uncertain dispatch remains visible in health; do not send a duplicate or create a replacement worker.

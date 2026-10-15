# How delivery works

This page tells how the Treelanes board plans, starts, checks and recovers
agent work. Read the [README](../README.md) first. The words in this page have
the meanings in [CONTEXT.md](../CONTEXT.md).

## Agent use

The plugin adds the `treelanes_move_card` tool. The agent gives it a stage
and can add a short note. The plugin finds the worktree from the current thread
and moves that worktree card.

Agents can also use the CLI commands in the [README](../README.md#cli).

The valid stage IDs are `tickets`, `design`, `tdd`, `quality`, `simplify`,
`review`, `pr`, and `done`.

`context` returns the Stage Owner, task and stage revisions, Saved Task, pause
state, and current worktree digest. Assign a first stage before reading it.
Only the Stage Owner can save a task or submit completion. The task and receipt
schemas are exported by `stage-evidence.ts`. Task changes increase its revision;
unchanged task data keeps the revision. Old receipts cannot advance new work.
Receipt checks record the worker's evidence; the board does not run those checks.

The board passes the Saved Task and prior result to each new worker. It alone
starts the next stage. Code Review stays outside this chain. A user can assign
separate work through the panel. The board does not merge pull requests.

## Adapt the plan to the task

A Saved Task can set `deliveryStages` to an ordered subset of `tdd`, `quality`,
`simplify`, and `pr`. Small fixes can use `["tdd","quality","pr"]`. Use
Simplify when cleanup adds value. Use `["tdd","quality"]` when the request ends
at checked code. The last receipt completes that plan without starting PR work;
the card keeps its current stage because Done still means the PR has merged.
Omitting the plan keeps the existing full stage chain.

TDD plans include Quality. Stages stay unique and in workflow order. A worker
can revise the plan for new findings but must keep the current stage in it.
Changing a plan changes the task revision and invalidates old receipts.

`stageChecks` can add named checks for `design`, `tdd`, `quality`, and
`simplify`. These checks add to `requiredChecks`, which apply at every stage.
For example, put a focused regression in `stageChecks.tdd` and a broader test
suite in `stageChecks.quality`. Keep any explicit cross-stage requirement in
`requiredChecks`. Context returns the combined check names and `nextStage`.
The next worker reads those values from fresh board context.

The delivery skill selects the plan and checks from the request and repository.
It refreshes stale context and retries temporary read failures within a small
limit. Scope changes that need a human decision still keep that decision open.

## Recovery and status

Recovery runs at startup, on settings changes, and every five minutes. It uses
saved launch records to recover failed starts and lost completion events. It
attaches an existing worker after a lost spawn reply and prevents duplicate
starts. Stale start claims wait two minutes. Uncertain legacy claims remain
blocked for inspection.

Launches stop after three attempts. Normal retries wait at least 30 seconds.
`reconcile` or a same-stage panel action can retry a failed start immediately,
but cannot reset the attempt limit. `health` lists pending starts, failures,
blocked starts, workers waiting for input, and missing or stale evidence.
`health` and `snapshot` do not start workers. A rejected current result remains saved as a Blocked Attempt. The card and health show it, and automatic restarts stop. Fresh passing evidence clears it. An unassigned context read returns `status: "unassigned"` without creating a card or starting work.

`pause` prevents recovery and automatic moves for a worktree. `resume` clears
that pause and checks its saved state. Recovery does not restart an idle worker
that has no receipt, override pending input, or dispatch duplicate work while
threads are active. PR Watch moves to Done after BB confirms the merge.

## Task setups

New tasks can save a `setup` instead of `deliveryStages`. Each step has a stable ID, title, stage, instructions, checks, and explicit execution choices. `execution.providerId` selects the harness. The model and effort must match the live provider catalog. Skills must exist and match the provider, or have no provider restriction. The board rejects missing and ambiguous choices without a default substitute.

For explicit manual setup, use `bb treelanes catalog [provider-id] [skill-query]` to inspect choices, save the task, then run `bb treelanes start` once. Automatic delivery lets the board plan and dispatch. The board stores the resolved choice before dispatch. `execution.selectedSkills` holds skill references returned by board context; the SDK has no skills launch field and this does not restrict tools. Existing permission settings still apply.

A setup has one to 24 steps. It can repeat a stage, add a check step, or omit work the task does not need. PR Watch can only be last. Each other step needs at least one check. Common and stage checks remain additive. The current owner can revise remaining work. Completed steps stay fixed. Prepared execution settings stay fixed; a selection that failed before dispatch can be corrected by the task owner. A changed plan needs a fresh receipt.

The card stage, active step, task versions, launch attempts, resolved settings, and receipts survive reload. Recovery resumes accepted completion and failed launches under the existing pause and retry limits. A stage change and its pending launch share a transaction. Each step, including a repeated stage, gets a new stage version.

`bb treelanes history` shows the latest ten task versions. `bb treelanes playbooks [project-id]` shows the latest five checked setups. A checked setup is an example, not an approval or a receipt for new files. A PR setup enters this list only after a verified matching merge. Done also requires the custom setup to finish. Code-only setups keep their last board stage.

The delivery skill chooses the initial setup from the request, repo rules, live catalog, and prior results. Workers adapt future steps when findings change the needed work. This is agent judgment with saved checks, not a learned model ranking or automatic tool isolation.


## Automatic delivery

For a new authorized task with accepted interfaces, call `treelanes_deliver` or `bb treelanes deliver '<json>'` with `{ "stage": "tdd", "task": { ... } }`. The task uses the existing outcome, scope, decisions, constraints, confirmations, checks, and allowed actions. Omit setup and deliveryStages. The board saves the request, starts a visible task orchestrator, validates its proposal, and dispatches the first step after setup is idle. The caller ends its turn after queuing. An identical repeat does not start another setup worker.

The setup worker uses the initiating thread's provider, model, effort, and permission limit. It reads current task context and the live catalog, consults checked setups when useful, then submits `treelanes_apply_setup`. The board accepts only a setup proposal; it retains the saved task authority. Each step's provider, model, supported effort, and skill choices must resolve against live catalogs. Setup workers receive the board context, catalog, playbook, and apply tools from this plugin. The platform still exposes its normal tools; this is not a file sandbox.

`treelanes_reopen` or `bb treelanes reopen '{"taskRevision":2,"reason":"User requested changed work"}'` returns an unpaused automatic PR Watch task to Design. Only the saved orchestrator or current owner may call it at the user's request. It rejects stale revisions, pending setup, other live work, and pending input. It keeps task versions and receipts, clears the active setup, and gives Design to the original orchestrator. Update the full task in Design, then complete Design or use explicit user Start. The board plans fresh steps in the same orchestrator and keeps PR Watch last. Reopen does not merge or close the existing PR.

`treelanes_recover` or `bb treelanes recover '{"reason":"...","nextAction":"..."}'` lets the current worker request a different plan for a concrete repair within the saved scope. Correct routine code, local test setup, and input errors in the same worker first. A recorded failed result requires `nextAction`; unchanged base or external failures do not justify another worker, and unresolved human decisions still block recovery. The worker ends its turn after an accepted recovery request. The board waits for idle state, then starts setup planning again. A failed turn does not trigger Plan Recovery or create another worker. At most two plan changes can occur for an automatic delivery. Each retains completed steps, the active step ID and stage, and every active check. Common task checks, scope, and actions remain unchanged. A new accepted plan gets new task and stage versions, so old receipts cannot advance it.

Setup requests have durable pending, starting, started, applied, stale, and blocked states. A conditional SQL claim prevents duplicate setup starts. A lost spawn response keeps its claim while recovery searches for the worker by its saved title. Setup starts get at most two attempts per request. Once a thread exists, the board keeps it. A failed turn uses same-thread retry; an idle worker remains available to submit its corrected plan. Pending input and paused work prevent dispatch. Exhausted setup attempts remain blocked and appear in health; they do not retry forever.

If the task owner changes the Saved Task before its first plan is applied, the board replaces the old Setup Request with one for the current task revision. This also repairs stale initial requests after a reload. The delivery request stays the same, and this task update does not use a Plan Recovery attempt. The old planner cannot submit a plan. Dispatch waits for other workers and pending input to clear. A stage change does not restart initial planning. Health reports a stale request for the current stage even when no implementation worker has started.

The setup worker runs as a normal child thread because the current public SDK has no direct structured model inference call. There is no new inference service or credential requirement. New automatic delivery behavior applies only to tasks submitted through deliver. Existing manual tasks retain their prior behavior.


### Same-thread retries

A failed assigned setup or task worker resumes through `threads.retry`, with its failed turn ID. The board keeps the thread, execution choice, task revision, and stage. It does not create a Setup Request for a runtime failure. Routine check and tool-input repairs also stay in the same worker.

The board saves each retry claim before dispatch. Each assignment allows two retries, with at least 30 seconds between automatic attempts. `resume` and `reconcile` can bypass the delay, but cannot reset the limit or resend the same failed turn. Saved claims survive reload. If a retry response is lost, health reports `retry-uncertain`; the board does not repeat an uncertain dispatch or create a replacement thread.

Paused work, pending input, queued work, and recorded check blockers prevent automatic retries. Idle or stopped threads do not restart on a timer. Unavailable threads remain visible for inspection. A later planned step or an explicit Plan Recovery can still need a new worker.

### TDD repair continuation

A failed check keeps TDD incomplete but need not end its worker's work. Fix it in
the same thread and rerun affected checks. If the worker must yield with a
concrete repair left, it can include `nextAction` in its failed completion report.
The board returns `recorded: false, action: "repair"`, retains the failed evidence,
and sends that action once to the same thread after normal turn completion.
Only fresh passing evidence permits a completion marker and Quality dispatch.

A saved claim prevents duplicate sends for the same action, files, and task
revision, including after reload or a lost send response. A pause, pending input,
queued work, a stop, or a newer turn prevents the old repair from starting.
Existing failed reports without a repair action do not restart on upgrade.
The card and health show the repair state and action, including uncertain sends.

Continue independent work while deferring questions and dependencies that cannot
affect it. Keep deferred items visible; required items still need resolution.
Test-interface selection is pre-approved. Product decisions and external actions
retain the task's existing approval requirements.

A completed local setup keeps its last stage and shows
"Complete locally. No PR step is planned." It does not grant permission to push
or create a PR. Done still means a verified merge.


### Persistent task orchestration

Each new automatic task defaults to `deliveryTarget: "pr"`. Its setup thread stays as the task orchestrator, and subsequent workers are its children. The default plan is TDD → Quality → Simplify → PR Watch. The orchestrator and Stage Owner may adapt intermediate steps; plan validation keeps PR Watch last. An explicit local-only task can request `deliveryTarget: "local"`. Existing saved tasks keep their accepted limits.

Plan Recovery returns to the same orchestrator thread. A normally completed worker turn without a receipt can receive a bounded continuation in that same thread. TDD, Quality and Simplify can continue a concrete repair via failed evidence with `nextAction`. Other recorded technical blockers can go to the existing orchestrator for diagnosis and child guidance. It cannot grant missing authority or convert failed checks into passing evidence. Stops, pauses, queued work and pending input remain gates. Continuation and help claims survive reload and do not resend uncertain requests.

When a task update abbreviates completed steps, the board retains their saved records and accepts valid changes to current and future work. Removing, reordering or changing the identity of a completed step still fails validation. This allows a caller to append PR Watch without copying each completed instruction verbatim.

## Short handoffs

Stage prompts name `/delivery` and the stage skill, then give assignment IDs. Workers read the full Saved Task, active step, exact checks, and selected skill references from current board context. Task text, prior receipts, and catalogs are not copied into each prompt.

Delivery routes setup, task changes, recovery, and PR Watch to separate references. Resumed workers use `bb skill show` for current files because their cached skill copy may be old. Setup and blocker prompts also use these references. Setup context omits a workspace digest so an orchestrator can inspect the task during a capture failure; stage completion still requires full current evidence.

Treelanes starts orchestrators and stage workers with explicit visible status so a hidden parent cannot hide current work from the sidebar. Settled and archived states remain separate.

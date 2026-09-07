# Workflow Board for bb

Workflow Board adds a kanban panel to bb. Each card is one Git worktree. The
card lists all unsettled threads in that worktree.

The board ignores threads outside Git worktrees. It also hides each thread that
remains on the T3 Sidebar Settled shelf. A card leaves the board when its
worktree has no unsettled threads. New work or attention makes a settled thread
appear again.

## Board

1. Tickets — a Linear ticket or work that you create.
2. Design — shape the work with Wayfinder or Grilling.
3. Implementation — one large group with three steps:
   - TDD — define seams, write tests, and build.
   - Quality Loop — run strict review until it has no findings.
   - Simplify — reduce the code and remove needless parts.
4. PR Watch — collect all implementation files from staged, unstaged, and
   untracked changes, commit and push them, reuse the open pull request or
   create a ready-for-review pull request against the base branch with a simple
   `/show-me` description, then watch it. PR Watch fixes check failures caused
   by the branch. It records unrelated or missing-service failures in the pull
   request and continues. For UI changes, it captures the running UI and uses
   GitHub CLI to add at least one screenshot to the pull request body.
5. Done — the pull request has merged.

The worktree owns the stage. Drag a card to assign work by hand. A live stage
worker prevents a conflicting move. Agents keep the Design Gate and Code
Review boundary. For a Saved Task, agents cannot skip forward through
Implementation with the move command.

Automatic moves require a Completion Receipt from the Stage Owner. The board
checks the task revision, stage revision, required check names, and worktree
digest before each move. Missing or incomplete file data prevents a move.
A completion marker alone does not advance work. Done requires BB to confirm
a merged pull request whose head branch matches the worktree.

Select a worktree card to open its newest unsettled thread in the right pane.
Select a listed thread to open that thread. The pane also has an action that
opens the full thread.

The board also has search, All, Active, and Attention views, a New work action,
stage buttons in the thread pane, and a small-screen layout.

## Agent use

The plugin adds the `workflow_board_move_card` tool. The agent gives it a stage
and can add a short note. The plugin finds the worktree from the current thread
and moves that worktree card.

Agents can also use these commands:

```sh
bb workflow-board stages
bb workflow-board show [project-id]
bb workflow-board move <stage> [thread-id] [note]
bb workflow-board context
bb workflow-board task '<JSON>'
bb workflow-board complete '<JSON>'
bb workflow-board health [project-id]
bb workflow-board reconcile [project-id]
bb workflow-board pause [environment-id]
bb workflow-board resume [environment-id]
bb workflow-board snapshot <environment-id>
```

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
The next worker receives those values in its handoff.

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
`health` and `snapshot` do not start workers.

`pause` prevents recovery and automatic moves for a worktree. `resume` clears
that pause and checks its saved state. Recovery does not restart an idle worker
that has no receipt, override pending input, or dispatch duplicate work while
threads are active. PR Watch moves to Done after BB confirms the merge.

## Install and check

```sh
npm install
npm test
npm run typecheck
npm run build
bb plugin install .
```

The plugin stores each stage by worktree environment ID. It keeps old
thread-card data only to carry an existing stage into the new worktree card.


## Task setups

New tasks can save a `setup` instead of `deliveryStages`. Each step has a stable ID, title, stage, instructions, checks, and explicit execution choices. `execution.providerId` selects the harness. The model and effort must match the live provider catalog. Skills must exist and match the provider, or have no provider restriction. The board rejects missing and ambiguous choices without a default substitute.

Use `bb workflow-board catalog [provider-id] [skill-query]` to inspect choices, save the task, then run `bb workflow-board start` once. The board stores the resolved choice before dispatch. `selectedSkills` holds skill references for the prompt and handoff; the SDK has no skills launch field and this does not restrict tools. Existing permission settings still apply.

A setup has one to 24 steps. It can repeat a stage, add a check step, or omit work the task does not need. PR Watch can only be last. Each other step needs at least one check. Common and stage checks remain additive. The current owner can revise remaining work. Completed steps stay fixed. Prepared execution settings stay fixed; a selection that failed before dispatch can be corrected by the task owner. A changed plan needs a fresh receipt.

The card stage, active step, task versions, launch attempts, resolved settings, and receipts survive reload. Recovery resumes accepted completion and failed launches under the existing pause and retry limits. A stage change and its pending launch share a transaction. Each step, including a repeated stage, gets a new stage version.

`bb workflow-board history` shows the latest ten task versions. `bb workflow-board playbooks [project-id]` shows the latest five checked setups. A checked setup is an example, not an approval or a receipt for new files. A PR setup enters this list only after a verified matching merge. Done also requires the custom setup to finish. Code-only setups keep their last board stage.

The delivery skill chooses the initial setup from the request, repo rules, live catalog, and prior results. Workers adapt future steps when findings change the needed work. This is agent judgment with saved checks, not a learned model ranking or automatic tool isolation.


## Automatic delivery

For a new authorized task with accepted interfaces, call `workflow_board_deliver` or `bb workflow-board deliver '<json>'` with `{ "stage": "tdd", "task": { ... } }`. The task uses the existing outcome, scope, decisions, constraints, confirmations, checks, and allowed actions. Omit setup and deliveryStages. The board saves the request, starts a hidden setup worker, validates its proposal, and dispatches the first step after setup is idle. The caller ends its turn after queuing. An identical repeat does not start another setup worker.

The setup worker uses the initiating thread's provider, model, effort, and permission limit. It reads a bounded live catalog and prior checked setups, then submits `workflow_board_apply_setup`. The board accepts only a setup proposal; it retains the saved task authority. Each step's provider, model, supported effort, and skill choices must resolve against live catalogs. Setup workers receive only the board context, catalog, and apply tools from this plugin. The platform still exposes its normal tools; this is not a file sandbox.

`workflow_board_recover` or `bb workflow-board recover <reason>` lets the current worker report a technical failure after bounded local fixes. The worker ends its turn. The board waits for idle state, then starts setup planning again. A failed worker or exhausted stage launch can also trigger recovery. At most two plan changes can occur for an automatic delivery. Each retains completed steps, the active step ID and stage, and every active check. Common task checks, scope, and actions remain unchanged. A new accepted plan gets new task and stage versions, so old receipts cannot advance it.

Setup requests have durable pending, starting, started, applied, stale, and blocked states. A conditional SQL claim prevents duplicate setup starts. A lost spawn response keeps its claim while recovery searches for the worker by its saved title. Setup workers get at most two attempts per request. Pending input and paused work prevent dispatch. Exhausted setup attempts remain blocked and appear in health; they do not retry forever.

The setup worker runs as a normal child thread because the current public SDK has no direct structured model inference call. There is no new inference service or credential requirement. New automatic delivery behavior applies only to tasks submitted through deliver. Existing manual tasks retain their prior behavior.

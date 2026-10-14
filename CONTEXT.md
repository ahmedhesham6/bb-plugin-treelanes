# Treelanes

Treelanes is one bb plugin with a board and a sidebar for Git Worktrees.

## Terms

**Git Worktree**: A checked-out Git branch that bb marks as a managed or unmanaged worktree.

**Worktree Card**: One board card for one Git Worktree. It contains all Unsettled Threads in that worktree. Avoid: thread card, root card.

**Main Thread**: The saved thread that represents a Git Worktree in the sidebar. It remains the main thread when other threads start or finish work.
_Avoid_: core thread, root card

**Child Row**: Another thread in the same Git Worktree, shown below its Main Thread. This display does not change the thread's actual parent.

**Settled Thread**: A thread the user placed in Settled, with no newer attention or live work. Treelanes stores this state. Settled Threads do not appear on the board.

**Snoozed Thread**: A thread the user postponed until a wake time, with no newer attention or live work.

**Unsettled Thread**: A bb thread that is in a Git Worktree and is not a Settled Thread. A thread becomes unsettled again when it has new attention or live work.

**Display Title**: A short sidebar name for an automatic board thread. The model that the Task Map selects for titles writes it in a short hidden thread. The original title remains for run recovery. A manual rename takes priority. Automatic titles are off by default.

**Worktree Stage**: The workflow stage stored for a Git Worktree. All threads in the worktree share this stage.

**Design Gate**: The boundary between Design and TDD. It opens when the user moves the Worktree Card to TDD or the assigned design worker submits a current Completion Receipt.

**Implementation**: The grouped TDD, Quality Loop, and Simplify stages for work that changes code.

**Quality Loop**: The internal review-and-fix stage in Implementation. It ends only when the strict review has no findings.
_Avoid_: Code Review

**Code Review**: A `/code-review` review of external changes that reports findings and makes no code changes. It is not part of Implementation and starts no later stage.
_Avoid_: Quality Loop

**PR Watch**: The final delivery stage when the Saved Task includes a pull request. It collects all implementation files from staged, unstaged, and untracked changes, commits and pushes them, reuses the open pull request for the current branch and base or creates a ready-for-review pull request, then watches it. It fixes check failures caused by the branch. It records unrelated, existing, flaky, or missing-service failures and continues to the pull request. When it creates a pull request, it uses `/show-me` to write the description, then continues `/babysit-pr`. When the branch changes the UI, it captures the running UI and uses GitHub CLI to upload at least one screenshot to the pull request body.

**Saved Task**: The authorized outcome, scope, decisions, constraints, planned stages, checks, and allowed actions that workers share for a Worktree Card.

**Stage Owner**: The thread assigned to report completion for the current Worktree Stage.

**Completion Receipt**: A saved result from the Stage Owner that binds check evidence and resolved findings to the current Saved Task and worktree files.

**Task Setup**: The saved list of steps and reasons chosen for one Saved Task. It can add or remove future work as findings change.

**Setup Step**: One worker assignment with a stable ID, Worktree Stage, instructions, checks, and execution choices. Several Setup Steps can use the same Worktree Stage.

**Execution Choice**: The bb provider, model, supported reasoning effort, selected skill references, and reason for one Setup Step. The provider selects the harness. The board stores the resolved choice before dispatch.

**Task Map**: The Settings section that lists each task kind's template steps, plus the orchestrator and automatic titles, with a harness, model, and effort for each. A saved choice binds setup planning and validation for steps that have not started. "Orchestrator chooses" leaves the choice open. Settings and health report a saved choice that the live catalog cannot run.

**Checked Setup**: A completed Task Setup with its actual Completion Receipts, or matching PR merge. It is an example for future tasks, not approval or evidence for new work.

**Automatic Delivery**: An authorized Saved Task submitted once so the board manages setup planning and worker dispatch.

**Setup Request**: A durable request for a setup-only worker to propose a Task Setup. The board validates the proposal before saving it.

**Plan Recovery**: At most two new Setup Requests for explicit changes to the plan after technical failures in an Automatic Delivery. A failed turn alone does not start Plan Recovery. Each keeps the saved scope, actions, common checks, completed steps, and active checks.

**Reopen**: A user-requested return from PR Watch to Design for changed work. The same task keeps its original orchestrator and prior versions and receipts. The active setup clears; a new setup request waits for Design completion or explicit Start. Fresh steps require fresh checks.

**Blocked Attempt**: A current failed or incomplete result saved from the Stage Owner. It retains the exact check statuses and evidence without completing the stage. The card and health show the blocker. Automatic recovery stops until fresh passing evidence clears it or the owner requests a concrete in-scope recovery action.

**Same-thread Retry**: A bounded retry of a failed turn in its assigned thread. It keeps the execution choice, task revision, and stage. A saved claim prevents duplicate dispatch after reload. Each assignment permits two retries. It cannot grant approval, clear a check blocker, or restart an idle or stopped worker.

**One-time Import**: `bb treelanes import` copies the data of the earlier workflow-board and worktree-sidebar plugins into a new Treelanes install in one transaction. It refuses a destination that has data, and a second run does nothing.

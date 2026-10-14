# Task requests

## New automatic task

Read the request and repository rules. Register this thread as the task orchestrator: submit `workflow_board_deliver` or `bb workflow-board deliver '<JSON>'` once:

```json
{"stage":"design","task":{"outcome":"...","scope":[],"decisions":[],"constraints":[],"testInterfaces":[],"decisionInputs":[],"confirmations":[],"requiredChecks":[],"allowedActions":[]}}
```

Fill the arrays from the accepted request and exact repository checks. The board saves the task and waits in Design. This thread handles design with `/grilling` and stays as orchestrator; do not create an orchestrator child. Keep implementation checks in `requiredChecks` and design checks in `stageChecks.design`. After a checked Design or Grilling completion, the board sends the setup assignment to this same thread. If the user explicitly asks to start, call `workflow_board_start` once or use `bb workflow-board start`; never infer this instruction. A user move from Design to TDD also starts setup. Then follow the orchestration reference and let the board dispatch implementation children.

Delivery defaults to `deliveryTarget: "pr"`. Use `"local"` only for an explicit task restriction against a PR, and record its source. Neither target permits merge or deployment without authority.

Retry with the same complete payload and array order. The board returns the existing request. A changed payload needs a task update; repeated `deliver` calls do not revise it or move its stage. Inspect an error and board health before retrying. Missing board state is not a reason to install or enable a plugin.

## Saved task update

If the user requests new implementation while PR Watch is active, use the Reopen path below. Routine PR fixes still belong to the PR owner.

Read fresh context. Only `ownerThreadId` may save the full task through `workflow_board_set_task` or `bb workflow-board task '<JSON>'`. Other threads send the authorized change and source message to that owner with `bb thread tell`, then end. If no owner exists, report the exact blocker.

Retain the full task, including future steps. Add, remove, or reorder future work within scope. Keep completed step IDs, stages, and order, and the active step ID and stage. The board retains completed details if an update abbreviates them. Once dispatch is prepared, keep the active execution choice fixed; put a different choice in a future step. Keep PR Watch last for a PR-targeted task.

After saving, read context again. The returned `taskRevision` governs fresh evidence. Keep explicit required checks; extra focused checks do not replace them. Shorten step instructions by referring to the saved task, not by dropping its requirements. Use tool schemas for field limits.

Existing tasks may use `deliveryStages` and `stageChecks` instead of `setup`. Prefer `setup` alone. A matching legacy stage list is accepted and removed; a conflicting list needs correction. Legacy stage lists are ordered and unique; TDD includes Quality. Without either plan, the full chain applies.

## Reopen PR Watch

When the user requests changed work through a new workflow cycle, the saved orchestrator or current owner calls `workflow_board_reopen` or `bb workflow-board reopen '<JSON>'` with the current `taskRevision` and a `reason` that cites the request. Read context first. Reopen requires an unpaused automatic task in PR Watch; other running work and pending input must settle first.

Reopen returns the same task to Design under its original orchestrator. It keeps the prior task versions and receipts as history, clears the active setup, and creates a fresh setup request. It does not merge or close the PR, change the code, or start a worker.

The Design owner saves the full revised task, retaining existing requirements and adding the accepted changes. Reuse acceptance that still covers the revised task. Complete Design with fresh evidence, or use Start when the user explicitly asked to start. Plan fresh steps with PR Watch last and reuse the existing PR. Prior checks do not complete the new steps.

## Accepted decisions

Use plain string entries for task arrays. `testInterfaces` names accepted public interfaces. `decisionInputs` records the inputs to a choice. Each `confirmations` entry cites a thread/message or file section and names the scope and decisions it covers.

Reuse acceptance when it covers the current outcome, relevant scope, constraints, and inputs. A revision alone does not cancel it. If a relevant value changes, ask only for the affected choice. Several confirmation entries may combine only when each covers the same current scope. This requires reading the evidence; the board does not infer approval.

Routine choices within accepted interfaces need no new gate. A change to the outcome, constraints, public interface, or authority needs matching acceptance. Silence, a worker result, or a recommendation does not grant it. Put only accepted choices in `decisions`; `decisionsResolved` belongs to a receipt, not the task payload.

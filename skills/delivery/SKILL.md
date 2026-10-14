---
name: delivery
description: Deliver authorized Git Worktree tasks through Treelanes. Use for new tasks, stage handoffs, task orchestration, and recovery; honor explicit workflow opt-outs.
---

# Delivery

Read the request before board access. Keep the saved scope, constraints, accepted decisions, exact checks, and allowed actions. Fix routine issues within that scope without asking the user. Keep user stops and missing authority in force.

For coding delivery, read `/ponytail` as the implementation guide; default to full unless the user selects another level or turns it off. Keep the selected level or explicit stop in child step instructions.

## Choose the path

- **Workflow opt-out:** run the requested skill directly. Read no board context, save no task, and submit no receipt. This also applies outside Git.
- **External `/code-review`:** report Standards and Spec findings only. Make no edits or board changes. Research uses `/research` and also returns without a workflow.
- **New task or task change:** read [task requests](references/task-requests.md). New tasks use `treelanes_deliver` once and stay in Design. This thread is the orchestrator. Start automation after checked Design completion or an explicit user Start.
- **Task orchestrator:** read [orchestration](references/orchestration.md) for setup assignments or child-blocker reviews. The board starts children and moves cards.
- **Explicit manual setup:** read [manual setup](references/manual-setup.md). That path uses `start` for a prepared setup; an explicit user Start can also open the automatic Design Gate.
- **Existing stage worker:** follow the steps below.

## Execute the assigned step

1. Read `treelanes_get_context` or `bb treelanes context`. Confirm this thread is `ownerThreadId` and the task is unpaused. If `status` is `unassigned`, use the new-task path; keep unresolved choices in Design. A missing or failed context read uses [recovery](references/recovery.md).
2. Follow the full saved `task` and `activeStep`. Load `execution.selectedSkills` from their returned references. Read the prior thread only when you need its evidence. Use the stage skill below even when no extra skills were selected. In TDD, Quality, and Simplify, also apply `/ponytail` at the saved level unless the user turned it off.
3. Complete the assigned work and exact `requiredChecks`. Reuse accepted decisions that still cover the current scope and inputs. If a decision changed, read [task requests](references/task-requests.md). If work fails or you need to yield with a repair left, read [recovery](references/recovery.md).
4. Submit the stage result below. End this turn; the board starts the next step after this worker becomes idle.

| Stage | Skill and result |
| --- | --- |
| Design | `/grilling`: resolve open choices and confirm shared understanding. Keep the Design Gate until accepted. |
| TDD | `/tdd`: implement through accepted test interfaces. |
| Quality | `/thermo-nuclear-code-quality-review`: review the task diff and fix valid findings within scope. |
| Simplify | `/simplify`: reduce needless code while keeping behavior. |
| PR Watch | Read [PR Watch](references/pr-watch.md), then use `/babysit-pr`. Leave merge to the user. |

Normal delivery is TDD → Quality → Simplify → PR Watch. Findings may justify adding, removing, or revising intermediate steps. Read [task requests](references/task-requests.md) before saving a change. Keep PR Watch last for `deliveryTarget: "pr"`; an explicit local-only task keeps its saved limit. Execute only the current step. An implementation worker never calls `start` or dispatches the next worker.

## Submit the stage result

Design, TDD, Quality, and Simplify use `treelanes_complete_stage` or `bb treelanes complete '<JSON>'`. After the last edit and check, read fresh context. Submit its `stage`, `stageUpdatedAt`, `taskRevision`, and `workspaceDigest`, plus `checks`, `decisionsResolved`, `openFindings`, and `summary`.

Each check has its exact effective name, actual status, and evidence. Skipped, missing, failed, or blocked checks cannot count as passed. For PR delivery, diagnosed base or environment failures may permit stage progress with their actual status; use the check classification in [recovery](references/recovery.md). Set `decisionsResolved: false` for an open human choice. Changed task or file evidence needs the recovery path, not a reused receipt.

Only `recorded: true` permits a completion marker. End with the stage's exact marker on a line of its own:

| Stage | Marker |
| --- | --- |
| Design | `[workflow:grilling-complete]` |
| TDD | `[workflow:tdd-complete]` |
| Quality | `[workflow:quality-clear]` |
| Simplify | `[workflow:simplify-complete]` |

When `nextStep` is null, finish without extra stages. A local result is not Done: Done requires a verified PR merge. PR Watch stays at ready to merge until the user merges or closes it.

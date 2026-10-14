---
name: simplify
description: Simplify a task's changes without changing behavior. Use for a Workflow Board Simplify step or an explicit request to reduce code and complexity.
---

# Simplify

Use the current task's scope, public interfaces, and required checks.

1. Read the task diff from its saved base, including current uncommitted files. Find needless branches, repeated logic, unused code, or abstractions that make the change harder to read.
2. Make only reductions that improve clarity and preserve behavior. Keep error handling, access limits, and public contracts. Leave unrelated cleanup for a separate task.
3. Run checks affected by each change and retain valid evidence for unchanged work. Revert a proposed simplification if it makes the code harder to understand or changes behavior.

Finish when the scoped change has no useful reduction left and its required behavior checks hold. A no-change result is valid. Report what changed and how you checked it; an assigned board worker then uses `/delivery` to submit its result.

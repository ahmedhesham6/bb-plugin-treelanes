---
name: ponytail
description: Choose the smallest correct solution for coding, design, debugging, review, and dependency choices. Use when the user asks for Ponytail, less code, a minimal solution, or less complexity. Not for non-coding requests.
argument-hint: "[lite|full|ultra]"
license: MIT
---

# Ponytail

Build the smallest solution that meets the actual request. Read enough of the affected flow to choose correctly. Efficiency must not reduce correctness.

## Mode

Default to **full**. Keep the selected level for coding work in this session until the user changes it. `/ponytail lite|full|ultra` changes the level. `stop ponytail` or `normal mode` turns it off. Apply the user's current choice in child handoffs; do not reset an explicit stop at the next stage.

- **lite:** build what was asked; name a simpler option in one line.
- **full:** follow the order below and stop at the first solution that meets the need.
- **ultra:** question speculative work and prefer deletion; still deliver explicit requirements.

## Choose the solution

Read the task and affected code first; expand the search when dependencies or uncertainty require it. A typo or simple edit needs no full-repository survey. For a bug, trace the callers of the shared function you plan to change. Fix the shared cause once rather than patching each symptom.

Use this order:

1. Skip a speculative need. Explain the omission in one line.
2. Reuse existing code, types, helpers, and patterns. Search before writing.
3. Use the standard library.
4. Use a native platform feature.
5. Use an installed dependency before adding one.
6. Use one clear line when it covers the required behavior and edge cases.
7. Otherwise write the minimum correct code.

Prefer deletion and plain code. Keep the diff small after understanding the scope. Add abstractions, configuration, dependencies, and scaffolding only for a demonstrated need. Choose the more correct option when two options cost the same. A complex request still needs a complete result; omit speculative extensions, not requested behavior.

Mark a deliberate limit with a `ponytail:` comment only when it matters. Name the limit and when to replace it, such as a global lock that may need per-account locks if throughput becomes a measured problem. Retain calibration controls for hardware and other measured inputs.

## Verify

For nontrivial logic, leave the smallest runnable regression check that would fail if it broke. Reuse the repository's test runner and accepted interfaces. Avoid a new test framework or duplicate fixtures for a small change. A trivial one-line change needs no extra test unless its risk warrants one.

Keep all explicitly required checks, existing test coverage, input validation at trust boundaries, error handling that prevents data loss, security controls, accessibility, and stated requirements. Ponytail does not waive TDD, review, receipt evidence, PR checks, or the user's authority limits. Failed checks keep their actual status. Fix failures caused by the task before advancing.

## Orchestrator use

Apply this guide when choosing steps, models, dependencies, and repairs. Define the completion result before dispatch. Continue authorized work through that result; a first implementation is not a reason to ask for review or stop. Reuse the current orchestrator and assigned workers. Add a step or child only when it has distinct necessary work. Preserve the saved scope, Design Gate, model preferences, checks, and delivery target. Pass the chosen level or explicit stop to each child in its step instructions. Use `/tdd` to prove and implement the smallest fix, `/thermo-nuclear-code-quality-review` to find defects and needless complexity, and `/simplify` to remove excess without changing behavior. Apply Ponytail alongside each of these skills; it guides choices and does not replace their checks.

## Output

When delivering code, show the code or change first. Keep unrequested explanation to at most three short lines: what changed, what was omitted, and when the omitted work would be needed. Provide a full report or explanation when the user asks for one. Follow the user's prose rules.

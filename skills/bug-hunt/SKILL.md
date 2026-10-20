---
name: bug-hunt
description: Hunt failure paths in each external call and stored state. Use in Design to build a failure table before code, and on a task diff before a PR for code that will merge.
---

# Bug Hunt

Hunt the failure paths that green tests against fakes miss. The targets are each **external call** (a provider API, webhook, queue, email or other network request) and each piece of **stored state** (a database row, file, cache or saved setting) that the work touches.

## Failure questions

Answer each question for each target:

1. **Failure**: it fails, times out, or returns 4xx, 5xx or partial data. What state remains, and is a retry safe?
2. **Lost reply**: the far side succeeds but we see an error, such as a delete that happened with a 500 reply. Does our state still match?
3. **Overlap**: it runs twice or overlaps, such as two cron runs, a retry or concurrent webhooks. Is there a double effect? Release database row locks before any HTTP call.
4. **Other paths**: who else reads or writes this state? List every path: scheduled, manual, health check, UI.
5. **Leaks**: do secrets, personal data or provider bodies reach logs? Do cookies and proxy destinations stay in bounds?

**Fix the class**: when a finding names one path, search every path from question 4 that touches the same state and fix them together.

## Design branch

Use while you resolve the design, before any code.

1. List each external call and stored state that the plan touches.
2. Answer every failure question for each target. Save each answer as a decision `Failure: <target>, <question>: <behavior>, covered by <test or accepted risk>`.
3. Save a claim from a person or a document ("the API returns X", "all scopes are allowed") in `decisionInputs` as `Unconfirmed: <claim>`. It becomes a decision only after a real call confirms it.

Done when every target has a `Failure:` row for every question.

## Diff branch

Use on the full task diff from its base, including uncommitted work.

1. Hunt in a sub-agent. Give it the diff and this skill, and ask for each external call and stored state in the diff with an answer to every failure question, each citing `file:line`.
2. Spec pass: each saved decision and each `Failure:` row has code or a test in the diff. A missing one is a finding.
3. Fix each finding and its class. Turn each answer into a test, or into an accepted-risk line `Accepted risk: <target>, <question>: <reason>` in the stage summary for the PR body.
4. Rerun the checks that the fixes affect.

Done when each external call and stored state in the diff has a test or an accepted-risk line for every failure question. A diff with neither passes with the evidence `no external call or stored state`.

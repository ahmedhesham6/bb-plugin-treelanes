---
name: pr-proof
description: Proof and readiness rules for a pull request of code that will merge. Use when you open or update a PR, decide on a bot review finding, or report a PR ready.
---

# PR Proof

## Proof is a run

A check passes when a run shows it: a command you executed and its output, quoted in the receipt or the PR. Green tests against fakes show only that the code matches the fakes.

- For each external API the change calls, make one real call before the PR is ready, in a sandbox, the dev environment or a local stack in read-only mode. Save the real reply, remove secrets and personal data from it, and build the test fixture from it.
- Treat a claim from a person or a document as a hypothesis until a real call confirms it.
- When no safe real call exists, add the call to **Not verified** with the check to run on dev after merge.

## Bot findings

Fix each Greptile P1 and each Cursor Bugbot finding at Medium or higher. To decline, defer or mark one as a false positive, bring it to the user with your reason and wait for their decision.

## Ready

Report the PR ready only after the bot reviews of its latest push finish.

## PR body

Copy the accepted-risk lines from the bug-hunt result. End the body with a **Not verified** section: each check you skipped or could not run, and why. Leave it empty only when a run showed every changed path. When the user says "go faster" or "just finish", cut scope and keep the list complete.

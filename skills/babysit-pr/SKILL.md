---
name: babysit-pr
description: Babysit a pull request until it is ready to merge — check review comments, PR discussion comments, and linked issue comments, fix real issues within the PR's scope, refute false positives, rebase, watch checks. Invoke immediately after creating a PR (gh pr create). Targets the current branch's PR by default.
argument-hint: [pr-number-or-url]
---

# Babysit a PR

Drive one PR to ready-to-merge. Each invocation is one pass: read the PR's state, act on everything actionable, report. If the PR still waits on an external event, watch for it (step 6) and run the next pass when it fires. Merging is the human's call — report ready-to-merge and stop.

**Scope** = the goal stated in the PR title and description. Read it first; it is the yardstick for every action this skill takes. Every line you change must serve the scope. When a comment asks for work outside it, the correct fix is a reply that names it as follow-up material — with the thread's suggestion acknowledged — never a commit.

## Pass

### 1. Load state

Identify the PR (from the argument, or the PR for the current branch via `gh pr view`). Collect:

- Title and body → the scope.
- Base branch and whether the branch is behind it (`gh pr view --json baseRefName,mergeStateStatus`).
- All unresolved review threads, review bodies, and top-level PR discussion comments, with author, ID, URL, body, update time, and path and line where available. Use [`gh-commands.md`](gh-commands.md) and fetch every page.
- Comments on issues linked through `closingIssuesReferences`, the PR description, or the user's task. Use each issue's own repository and number. If there are no linked issues, check the PR comments alone. Report any source you cannot read.
- Check results (`gh pr checks`).
- Review decision (`gh pr view --json reviewDecision`).

Track each comment by source, ID, and update time or body hash across passes. Read existing replies before acting. Recheck edited comments, including bot summaries that change in place. Keep unresolved work pending, but avoid duplicate replies to unchanged comments.

Done when: you can state the scope in one sentence and have read all review feedback, PR discussion comments, and linked issue comments.

### 2. Rebase

If the branch is behind its base: `git fetch origin && git rebase origin/<base>`, then `git push --force-with-lease`. On conflict, resolve keeping each side's intent — your branch's changes stay held to scope — or invoke the `resolving-merge-conflicts` skill if available.

Done when: the branch sits on the base tip and the remote matches.

### 3. Assess each comment

For each unresolved thread and each unhandled or edited review body, PR comment, or linked issue comment, investigate each actionable claim. Open the cited code, or locate it from the claim when no file or line is given. Run a focused check when it can test the claim. Apply the same scope and evidence rules to every source. Assign each claim one **verdict**:

- **real** — the comment identifies a genuine defect in this PR's changes, and fixing it serves the scope.
- **false-positive** — the claim is wrong, already handled, or rests on a misreading. You must hold concrete evidence (file:line, a test result, a spec citation) before choosing this verdict.
- **out-of-scope** — the concern may be valid, but addressing it changes lines the scope does not require.

Bot comments (author login ends in `[bot]`) get the same investigation as human ones — bots are frequently wrong and occasionally right, and the verdict must come from the code, never from the author.

Record comments with no request or claim, such as status updates or acknowledgements, as informational. They need no reply and do not block readiness.

Done when: every pending actionable claim has a verdict with evidence, and every other comment has been checked.

### 4. Act on every verdict

- **real** → fix it with the smallest change that resolves the comment. Commit, then reply on the thread naming the fix and the commit. Resolve the thread.
- **false-positive**, bot author → reply with the evidence (cite file:line or the test you ran), then resolve the thread.
- **false-positive**, human author → reply with the evidence, courteously, and leave the thread open — resolution is the reviewer's call.
- **out-of-scope** → reply that the suggestion is sound but belongs in a follow-up, offer to open an issue for it, and for bot authors resolve the thread; for humans leave it open.

For PR discussion comments, review bodies, and linked issue comments, post any needed reply on the source PR or issue and link to the original comment. These comments have no review-thread resolve state. Track their verdict and outcome in the pass record; use thread resolution only for review threads.

If checks fail: a failure caused by this PR's changes is a **real** verdict — fix it. A failure untouched by this PR's diff gets one rerun (`gh run rerun`), and if it persists, goes in the report as a blocker outside this PR.

Push all commits in one `git push` at the end. If you pushed fixes after an approval or a changes-requested review, re-request review: `gh pr edit --add-reviewer <login>`.

Done when: every verdict has produced its reply, and every fix is pushed.

### 5. Report

End the pass with a short status: threads resolved / replied / left open, PR and linked issue comments handled or pending, rebase result, check status, review decision, and the single next event you are waiting on (reviewer re-review, CI, nothing).

The PR is **ready to merge** when all four hold: zero pending actionable claims across review threads, review bodies, PR comments, and linked issue comments, branch on the base tip, checks green, review decision APPROVED. Fetch all comment sources once more before declaring readiness. If any source could not be read, report that blocker and do not claim readiness. Otherwise, report readiness and stop.

### 6. Stay on duty

The job ends only at the end state: the PR is ready to merge, or a human merged or closed it. Until then the agent stays up: a pass that ends waiting on CI, a reviewer, or a scanning bot leads into a watch, and the watch leads into the next pass. A fresh PR always starts this way, because bots and CI need minutes to produce anything actionable.

[`watch.py`](watch.py) in this skill's directory is the watcher. Use it for every watch, and improve it here when it misses an event, so every PR runs the same tested code. It reads every source step 1 reads (checks, review threads, reviews, PR and linked issue comments, the PR description, merge state), with all pages. It wakes the agent only for a pass's worth of work: a failed check, all checks done, new or edited feedback, a conflict, or a required rebase. A failed read is retried and never reported as a change.

1. **Baseline.** After the pass's last push and reply, run `python3 <skill-dir>/watch.py <PR> --baseline`. The watch then reports only what changed after this pass. Add `--issue OWNER/REPO#N` once for each linked issue the PR description does not name; later runs keep it.
2. **Arm** the watch the harness supports:
   - **Background command with exit notice** (Claude Code: Bash `run_in_background`): `python3 <skill-dir>/watch.py <PR>`. End the turn; the exit notice starts the next pass.
   - **Foreground only**: run the same command with the longest command timeout the harness allows, and `--timeout <minutes>` just under it.
   - **Scheduler with no long-lived process** (a bb automation): see [`scheduled-watch.md`](scheduled-watch.md).
3. **Act on the line it prints:**
   - `CHANGED`: run the pass again from step 1.
   - `CHANGED … PR is MERGED` or `CLOSED`: report the end state and stop.
   - `TIMEOUT`: arm again.
   - `ERROR`: the watch is blind. Report the blocker with the error text.

Done when: the end state is reached and reported, or a `watch.py` watch is armed on a fresh baseline.

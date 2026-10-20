# PR Watch

Use the saved task and current branch/base. Keep its authority limits. `/babysit-pr` owns the check, review, rebase, and watch loop after the PR exists. PR Watch owns getting required checks green. Earlier stages may hand off diagnosed base or environment failures with their actual results. Read those limits, diagnose remaining failures, make authorized fixes, rerun affected checks, and keep watching. Do not report ready to merge while any required check fails, is missing, or remains pending. Merge stays with the user; Done requires a verified merge.

Follow `/pr-proof` for run proof, bot findings, ready timing and the Not verified section.

## Prepare the PR

Before creating the PR and before every push, inspect the full branch diff against the Worktree base, plus staged, unstaged, and untracked changes. Stage only files required for the saved task, including its tests, config, migrations, generated files, and locks.

Include Markdown only when it is a requested deliverable or required product documentation within the saved scope. Keep extra Markdown files out of the PR: plans, research reports, review notes, temporary specs, ADRs, and CONTEXT.md created for agent context. Keep check evidence in the PR body or handoff. Unstage excluded files while preserving their contents. If their changes are already committed on the branch, remove those changes from the PR with a follow-up commit and preserve local copies. Complete this file review before each push, including pushes made during `/babysit-pr`.

Read applicable contribution guides and linked rules. Check files, tests, branch/commit names, and PR metadata against them. Fix valid gaps. Commit the scoped implementation, push the branch and unpushed commits, and set upstream if needed.

Fix branch-caused check failures and rerun affected checks. Record unrelated, existing, flaky, or missing-data/service/secret failures with their command and actual result. Continue to the PR with that evidence; normal CI may resolve an external limit. Keep failed results truthful.

Reuse an open PR for the current branch and Worktree base. Otherwise create a ready-for-review PR against that base. For a new description, use `/show-me`: state the change and checks in plain words, with a small Markdown visual only when it helps. Preserve an existing description; append needed evidence without rewriting it.

## UI evidence

When the diff changes visible UI, run the changed app and capture the changed state. Give each screenshot plain alt text and keep local images out of Git. Use a GitHub CLI whose help lists `--attach`:

- New PR: `gh pr create --attach '<path>#<alt text>'`.
- Existing PR: `gh pr edit <number> --attach '<path>#<alt text>'`.

Check `gh pr view --json body` to confirm each uploaded image appears. No UI change requires no screenshot.

Run `/babysit-pr` in the same worker until ready to merge, merged, or closed. Push each batch of fixes, monitor the new commit's checks and review comments, fix valid findings, reply with evidence, and resolve addressed threads under the skill's reviewer rules. Request re-review when needed. Repeat after each check or review event; a push or one clean pass does not end the watch. Report ready only when required checks are green, no actionable threads remain, the branch is current, and required approval is present. Keep the card in PR Watch; leave merge to the user.

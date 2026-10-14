# gh commands for PR feedback

Review threads (resolve state, thread IDs) live only in the GraphQL API. The REST API and `gh pr view` cannot see them.

## List unresolved threads

```sh
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              databaseId
              url
              updatedAt
              author { login }
              body
            }
          }
        }
      }
    }
  }
}' -F owner=OWNER -F repo=REPO -F pr=NUMBER \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
```

`id` (a GraphQL node ID like `PRRT_...`) is what `resolveReviewThread` needs. `databaseId` (an integer) is what the REST reply endpoint needs. Request `pageInfo { hasNextPage endCursor }` on both connections. Page with `reviewThreads(first: 100, after: ...)` if a PR has more than 100 threads, and page each thread's `comments` connection if it has more than 20 comments. Read all replies before acting.

## Reply to a thread

Reply to the thread's first comment by its `databaseId`:

```sh
gh api repos/OWNER/REPO/pulls/NUMBER/comments/COMMENT_DATABASE_ID/replies -f body='...'
```

## Resolve a thread

```sh
gh api graphql -f query='
mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}' -F id=THREAD_NODE_ID
```

Reply first, then resolve — a resolved thread with no reply reads as dismissal.


## List PR discussion comments and linked issue comments

GitHub uses the issue comments endpoint for top-level comments on both issues and PRs. These are separate from inline review comments. See the [GitHub issue comments API](https://docs.github.com/en/rest/issues/comments).

```sh
gh api --paginate 'repos/OWNER/REPO/issues/NUMBER/comments?per_page=100' \
  --jq '.[] | {id, author: .user.login, body, html_url, updated_at}'
```

Use the PR number first. Find linked issues with:

```sh
gh pr view NUMBER --repo OWNER/REPO --json body,closingIssuesReferences
```

Also read issue links in the PR description and the user's task. `closingIssuesReferences` covers closing links, not every related issue. For each linked issue, run the same comments query with its own owner, repository, and issue number. Fetch all pages. If the closing-issue list reaches the CLI limit, page the GraphQL `closingIssuesReferences` connection. See the [gh pr view fields](https://cli.github.com/manual/gh_pr_view).

## List review bodies

A reviewer can put feedback in the review body without an inline thread.

```sh
gh api --paginate 'repos/OWNER/REPO/pulls/NUMBER/reviews?per_page=100' \
  --jq '.[] | {id, author: .user.login, body, state, html_url, submitted_at}'
```

Track a body hash when a response has no update time. A count alone cannot detect edits.

## Reply to a discussion comment or review body

Write the reply to a file. Link to the original comment or review so the response has clear context.

```sh
gh pr comment NUMBER --repo OWNER/REPO --body-file /tmp/babysit-pr-reply.md
gh issue comment ISSUE_NUMBER --repo ISSUE_OWNER/ISSUE_REPO --body-file /tmp/babysit-pr-reply.md
```

Use only the command for the source PR or issue. These comments have no review-thread resolve state. Record the outcome and check prior replies before posting again.

#!/usr/bin/env python3
"""Wait until a GitHub PR changes in a way a babysit-pr pass must handle.

Modes:
  watch.py [PR] --baseline   Save the current PR state as seen. Run at the end of each pass.
  watch.py [PR]              Poll until something changed since the baseline, print one line, exit.
  watch.py [PR] --once       Compare once. Print one line if changed, nothing if not. For schedulers.

Exit codes: 0 = changed, terminal or no change (--once), 2 = PR state could not be read, 3 = timeout.
Needs only Python 3 and an authenticated gh.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

FAILED = {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"}
PENDING = "PENDING"
MAX_ERRORS = 5


class ReadError(Exception):
    pass


class NotFound(ReadError):
    pass


def gh(*args):
    try:
        result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise ReadError(f"gh {' '.join(args[:2])}: timed out")
    if result.returncode:
        if "HTTP 404" in result.stderr:
            raise NotFound(f"gh {' '.join(args[:2])}: not found")
        raise ReadError(f"gh {' '.join(args[:2])}: {result.stderr.strip()[:300]}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def graphql(query, **variables):
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if value is not None:
            args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    data = gh(*args)
    if data.get("errors"):
        raise ReadError(f"graphql: {data['errors'][0].get('message')}")
    return data["data"]


def rest_pages(path):
    pages = gh("api", "--paginate", "--slurp", path)
    return [item for page in pages for item in page]


def digest(text):
    return hashlib.sha256((text or "").encode()).hexdigest()[:16]


PR_QUERY = """
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state headRefOid body mergeable mergeStateStatus reviewDecision
      closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } }
    }
  }
}"""

CHECKS_QUERY = """
query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        }
      } } } } }
    }
  }
}"""

THREADS_QUERY = """
query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved
          comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { databaseId updatedAt } }
        }
      }
    }
  }
}"""

THREAD_COMMENTS_QUERY = """
query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { databaseId updatedAt } }
  } }
}"""


def read_checks(owner, repo, pr):
    checks, after = {}, None
    while True:
        data = graphql(CHECKS_QUERY, owner=owner, repo=repo, pr=pr, after=after)
        commits = data["repository"]["pullRequest"]["commits"]["nodes"]
        rollup = commits[0]["commit"]["statusCheckRollup"] if commits else None
        if not rollup:
            return checks
        contexts = rollup["contexts"]
        for node in contexts["nodes"]:
            if node["__typename"] == "CheckRun":
                result = node["conclusion"] if node["status"] == "COMPLETED" else PENDING
                checks[node["name"]] = result or PENDING
            else:
                checks[node["context"]] = PENDING if node["state"] in ("PENDING", "EXPECTED") else node["state"]
        if not contexts["pageInfo"]["hasNextPage"]:
            return checks
        after = contexts["pageInfo"]["endCursor"]


def read_threads(owner, repo, pr):
    threads, after = {}, None
    while True:
        page = graphql(THREADS_QUERY, owner=owner, repo=repo, pr=pr, after=after)
        connection = page["repository"]["pullRequest"]["reviewThreads"]
        for node in connection["nodes"]:
            comments = node["comments"]
            found = {str(c["databaseId"]): c["updatedAt"] for c in comments["nodes"]}
            cursor = comments["pageInfo"]["endCursor"] if comments["pageInfo"]["hasNextPage"] else None
            while cursor:
                more = graphql(THREAD_COMMENTS_QUERY, id=node["id"], after=cursor)["node"]["comments"]
                found.update({str(c["databaseId"]): c["updatedAt"] for c in more["nodes"]})
                cursor = more["pageInfo"]["endCursor"] if more["pageInfo"]["hasNextPage"] else None
            threads[node["id"]] = {"resolved": node["isResolved"], "comments": found}
        if not connection["pageInfo"]["hasNextPage"]:
            return threads
        after = connection["pageInfo"]["endCursor"]


def linked_issues(owner, repo, pr, info, extra, known_types):
    """Closing issues, issue links in the body, and --issue arguments. Pull requests are left out."""
    refs = {f"{n['repository']['nameWithOwner']}#{n['number']}" for n in info["closingIssuesReferences"]["nodes"]}
    body = info["body"] or ""
    refs |= {f"{o}/{r}#{n}" for o, r, n in re.findall(r"github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+)", body)}
    for o, r, n in re.findall(r"(?<![\w/#])(?:([\w.-]+)/([\w.-]+))?#(\d+)\b", body):
        refs.add(f"{o}/{r}#{n}" if o else f"{owner}/{repo}#{n}")
    refs |= set(extra)
    refs.discard(f"{owner}/{repo}#{pr}")
    issues = set()
    for ref in refs:
        if ref not in known_types:
            name, number = ref.split("#")
            try:
                item = gh("api", f"repos/{name}/issues/{number}")
                known_types[ref] = "pr" if item.get("pull_request") else "issue"
            except NotFound:
                known_types[ref] = "missing"
        if known_types[ref] == "issue" or ref in extra:
            issues.add(ref)
    return sorted(issues)


def snapshot(owner, repo, pr, extra, previous, known_types):
    info = graphql(PR_QUERY, owner=owner, repo=repo, pr=pr)["repository"]["pullRequest"]
    old = previous or {}
    issues = linked_issues(owner, repo, pr, info, extra, known_types)
    comments = {}
    for ref in [f"{owner}/{repo}#{pr}", *issues]:
        name, number = ref.split("#")
        comments[ref] = {str(c["id"]): c["updated_at"] for c in rest_pages(f"repos/{name}/issues/{number}/comments?per_page=100")}
    reviews = {
        str(r["id"]): f"{r['state']}:{digest(r.get('body'))}"
        for r in rest_pages(f"repos/{owner}/{repo}/pulls/{pr}/reviews?per_page=100")
    }
    # GitHub reports UNKNOWN while it recomputes merge state. Keep the last known value.
    mergeable = info["mergeable"] if info["mergeable"] != "UNKNOWN" else old.get("mergeable")
    merge_state = info["mergeStateStatus"] if info["mergeStateStatus"] != "UNKNOWN" else old.get("merge_state")
    return {
        "state": info["state"],
        "head": info["headRefOid"],
        "body": digest(info["body"]),
        "mergeable": mergeable,
        "merge_state": merge_state,
        "review_decision": info["reviewDecision"],
        "checks": read_checks(owner, repo, pr),
        "threads": read_threads(owner, repo, pr),
        "comments": comments,
        "reviews": reviews,
        "issues": issues,
    }


def changes(old, new):
    """What a pass must handle. Check successes while others still run, and base-branch moves, wake nothing."""
    found = []
    if new["state"] != "OPEN":
        return [f"PR is {new['state']}"]
    if new["head"] != old["head"]:
        found.append(f"head moved to {new['head'][:9]}")
    failed = sorted(n for n, r in new["checks"].items() if r in FAILED and old["checks"].get(n) != r)
    if failed:
        found.append(f"checks failed: {', '.join(failed)}")
    pending = [n for n, r in new["checks"].items() if r == PENDING]
    if new["checks"] and not pending and new["checks"] != old["checks"]:
        bad = sorted(n for n, r in new["checks"].items() if r in FAILED)
        found.append(f"all {len(new['checks'])} checks done, {len(bad)} failed" + (f": {', '.join(bad)}" if bad else ""))
    if new["mergeable"] == "CONFLICTING" and old["mergeable"] != "CONFLICTING":
        found.append("merge conflict with base")
    if new["merge_state"] == "BEHIND" and old["merge_state"] != "BEHIND":
        found.append("branch is behind base and the base requires an up-to-date branch")
    if new["review_decision"] != old["review_decision"]:
        found.append(f"review decision {old['review_decision']} -> {new['review_decision']}")
    new_threads = edited = reopened = 0
    for tid, thread in new["threads"].items():
        before = old["threads"].get(tid)
        if not before:
            new_threads += 1
            continue
        if before["resolved"] and not thread["resolved"]:
            reopened += 1
        edited += sum(1 for c, t in thread["comments"].items() if before["comments"].get(c) != t)
    for count, label in ((new_threads, "new review threads"), (edited, "new or edited thread comments"), (reopened, "threads reopened")):
        if count:
            found.append(f"{count} {label}")
    for ref, items in new["comments"].items():
        before = old["comments"].get(ref, {})
        count = sum(1 for c, t in items.items() if before.get(c) != t)
        if count:
            found.append(f"{count} new or edited comments on {ref}")
    count = sum(1 for r, v in new["reviews"].items() if old["reviews"].get(r) != v)
    if count:
        found.append(f"{count} new or changed reviews")
    if new["issues"] != old["issues"]:
        found.append(f"linked issues now {', '.join(new['issues']) or 'none'}")
    if new["body"] != old["body"]:
        found.append("PR description edited")
    return found


def resolve_pr(arg):
    view = gh("pr", "view", *([arg] if arg else []), "--json", "number,url")
    match = re.match(r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)", view["url"])
    return match.group(1), match.group(2), int(match.group(3))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pr", nargs="?", help="PR number or URL. Default: the current branch's PR.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--baseline", action="store_true", help="save the current state as seen, then exit")
    mode.add_argument("--once", action="store_true", help="compare once and exit")
    parser.add_argument("--issue", action="append", default=[], help="extra linked issue as OWNER/REPO#N, kept for later runs")
    parser.add_argument("--interval", type=int, default=90, help="seconds between polls (default 90)")
    parser.add_argument("--timeout", type=float, default=0, help="stop after this many minutes (default: none)")
    parser.add_argument("--renotify", type=float, default=60, help="--once: repeat an unhandled change after this many minutes")
    args = parser.parse_args()

    try:
        owner, repo, pr = resolve_pr(args.pr)
    except (ReadError, AttributeError, TypeError) as error:
        print(f"ERROR cannot identify the PR: {error}")
        return 2
    name = f"{owner}/{repo}#{pr}"
    state_dir = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "babysit-pr"
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / f"{owner}_{repo}_{pr}.json"
    saved = json.loads(state_file.read_text()) if state_file.exists() else {}
    known_types = saved.get("known_types", {})
    extra_issues = sorted(set(args.issue) | set(saved.get("extra_issues", [])))

    def save(**fields):
        saved.update(fields, known_types=known_types)
        state_file.write_text(json.dumps(saved))

    def read(previous):
        return snapshot(owner, repo, pr, extra_issues, previous, known_types)

    if args.baseline:
        try:
            save(baseline=read(saved.get("baseline")), notified=None, extra_issues=extra_issues)
        except ReadError as error:
            print(f"ERROR {name}: {error}")
            return 2
        print(f"baseline saved for {name}")
        return 0

    if args.once:
        try:
            current = read(saved.get("baseline"))
        except ReadError as error:
            errors = saved.get("errors", 0) + 1
            save(errors=errors)
            print(f"read failed ({errors}/{MAX_ERRORS}): {error}", file=sys.stderr)
            if errors % MAX_ERRORS == 0:
                print(f"ERROR {name}: {errors} reads failed in a row, last: {error}")
            return 2
        if saved.get("errors"):
            save(errors=0)
        if not saved.get("baseline"):
            save(baseline=current, notified=None)
            return 0
        found = changes(saved["baseline"], current)
        notified = saved.get("notified") or {}
        fresh = digest(json.dumps(found)) != notified.get("digest")
        stale = time.time() - notified.get("at", 0) > args.renotify * 60
        if found and (fresh or stale):
            save(notified={"digest": digest(json.dumps(found)), "at": time.time()})
            print(f"CHANGED {name}: {'; '.join(found)}")
        return 0

    deadline = time.time() + args.timeout * 60 if args.timeout else None
    baseline = saved.get("baseline")
    errors, delay = 0, args.interval
    while True:
        try:
            current = read(baseline)
            errors, delay = 0, args.interval
            if baseline is None:
                baseline = current
                save(baseline=baseline, notified=None)
            found = changes(baseline, current)
            if found:
                print(f"CHANGED {name}: {'; '.join(found)}", flush=True)
                return 0
        except ReadError as error:
            errors += 1
            print(f"read failed ({errors}/{MAX_ERRORS}): {error}", file=sys.stderr, flush=True)
            if errors >= MAX_ERRORS:
                print(f"ERROR {name}: {MAX_ERRORS} reads failed in a row, last: {error}", flush=True)
                return 2
            delay = min(delay * 2, 600)
        if deadline and time.time() + delay > deadline:
            print(f"TIMEOUT {name}: no change in {args.timeout:g} minutes", flush=True)
            return 3
        time.sleep(delay)


if __name__ == "__main__":
    sys.exit(main())

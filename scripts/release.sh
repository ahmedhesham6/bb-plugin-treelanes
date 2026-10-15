#!/usr/bin/env bash
# Tag and publish a release for the commits since the last vX.Y.Z tag.
# feat → minor; fix or perf → patch; a breaking change → major, or minor
# before 1.0.0. Other commit types release nothing. With no tag yet, the
# package.json version is the first release.
# RELEASE_DRY_RUN=1 prints the next tag, or "none", and changes nothing.
set -euo pipefail

last=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
if [[ -z $last ]]; then
  next=v$(node -p 'require("./package.json").version')
else
  subjects=$(git log --format=%s "$last..HEAD")
  bodies=$(git log --format=%b "$last..HEAD")
  IFS=. read -r major minor patch <<<"${last#v}"
  if grep -Eq '^[a-z]+(\([^)]*\))?!:' <<<"$subjects" || grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
    if ((major == 0)); then next=v0.$((minor + 1)).0; else next=v$((major + 1)).0.0; fi
  elif grep -Eq '^feat(\([^)]*\))?:' <<<"$subjects"; then
    next=v$major.$((minor + 1)).0
  elif grep -Eq '^(fix|perf)(\([^)]*\))?:' <<<"$subjects"; then
    next=v$major.$minor.$((patch + 1))
  else
    next=none
  fi
fi

if [[ -n ${RELEASE_DRY_RUN:-} ]]; then
  echo "$next"
  exit 0
fi
if [[ $next == none ]]; then
  echo "No feat, fix, perf or breaking change since $last: no release."
  exit 0
fi

if [[ -n $last ]]; then
  npm version "${next#v}" --no-git-tag-version >/dev/null
  git commit -q -am "chore(release): $next"
fi
git tag "$next"
git push --atomic origin HEAD:refs/heads/main "refs/tags/$next"
gh release create "$next" --title "$next" --generate-notes ${last:+--notes-start-tag "$last"}

#!/usr/bin/env bash
# Copy every skill in skills/SOURCES.md again from its source.
# Review the diff afterwards; never edit the copies by hand.
set -euo pipefail
skills=$(cd "$(dirname "$0")/../skills" && pwd)
pstack=$(mktemp -d)
trap 'rm -rf "$pstack"' EXIT
git clone --quiet --depth 1 https://github.com/backnotprop/pstack "$pstack"
commit=$(git -C "$pstack" rev-parse HEAD)

grep '^| [a-z]' "$skills/SOURCES.md" | while IFS='|' read -r _ name source _; do
  name=$(echo $name) source=$(echo $source)
  case $source in
    pstack:*) from=$pstack/${source#pstack:} ;;
    *) from=${source/#\~/$HOME} ;;
  esac
  rsync -aL --delete --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store "$from/" "$skills/$name/"
done
cp "$pstack/LICENSE" "$skills/pstack-LICENSE"
sed -i -E "s/^(\| [a-z-]+ \| pstack:[^|]+\| )[0-9a-f]{40}( \|)$/\1$commit\2/" "$skills/SOURCES.md"

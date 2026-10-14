#!/usr/bin/env bash
# Copy every skill in skills/SOURCES.md again from its source.
# Review the diff afterwards; never edit the copies by hand.
# Skills with source "plugin" live only here and are skipped.
set -euo pipefail
skills=$(cd "$(dirname "$0")/../skills" && pwd)
pstack=$(mktemp -d)
trap 'rm -rf "$pstack"' EXIT
git clone --quiet --depth 1 https://github.com/backnotprop/pstack "$pstack"
commit=$(git -C "$pstack" rev-parse HEAD)

names=() sources=()
while IFS='|' read -r _ name source _; do
  name=$(echo $name) source=$(echo $source)
  case $source in
    pstack:*) from=$pstack/${source#pstack:} ;;
    plugin) continue ;;
    *) from=${source/#\~/$HOME} ;;
  esac
  if [[ ! -d "$from" ]]; then
    echo "Missing source: $from" >&2
    exit 1
  fi
  names+=("$name") sources+=("$from")
done < <(grep '^| [a-z]' "$skills/SOURCES.md")
for i in "${!names[@]}"; do
  rsync -aL --delete --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store "${sources[i]}/" "$skills/${names[i]}/"
done
cp "$pstack/LICENSE" "$skills/pstack-LICENSE"
sed -i -E "s/^(\| [a-z-]+ \| pstack:[^|]+\| )[0-9a-f]{40}( \|)$/\1$commit\2/" "$skills/SOURCES.md"

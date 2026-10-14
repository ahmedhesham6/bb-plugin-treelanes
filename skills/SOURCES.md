# Skill sources

Each skill folder here is an unchanged copy of its source. Do not edit copied
files. To upgrade, run `scripts/sync-skills.sh` and review the diff.

Each copied skill keeps the MIT license of its upstream:

- grilling, tdd, codebase-design, diagnosing-bugs and code-review:
  <https://github.com/mattpocock/skills>, in
  [mattpocock-skills-LICENSE](mattpocock-skills-LICENSE).
- show-me: <https://github.com/humanlayer/skills>, in
  [humanlayer-skills-LICENSE](humanlayer-skills-LICENSE).
- thermo-nuclear-code-quality-review:
  <https://github.com/cursor/plugins/tree/main/cursor-team-kit>, in
  [cursor-team-kit-LICENSE](cursor-team-kit-LICENSE).
- babysit-pr: the bb built-in skill from <https://github.com/get-bb/bb>, in
  [bb-LICENSE](bb-LICENSE).
- The pstack skills: <https://github.com/backnotprop/pstack>, in
  [pstack-LICENSE](pstack-LICENSE).

Local sources are not in Git, so they have no commit.

Skills with source `plugin` have no other copy: this plugin owns them. Edit
them here; the script leaves them alone. A `local:<name>` source is a folder
named `<name>` under `$SKILLS_SOURCE`, the maintainer's skill folder.

Some copies drop text that names skills this plugin does not ship: one
sentence each in babysit-pr, code-review, principle-minimize-reader-load and
principle-sequence-verifiable-units. Remove that text again after a sync.

| Skill | Source | Commit |
| --- | --- | --- |
| grilling | local:grilling | none |
| tdd | local:tdd | none |
| codebase-design | local:codebase-design | none |
| diagnosing-bugs | local:diagnosing-bugs | none |
| thermo-nuclear-code-quality-review | local:thermo-nuclear-code-quality-review | none |
| babysit-pr | local:babysit-pr | none |
| show-me | local:show-me | none |
| code-review | local:code-review | none |
| delivery | plugin | none |
| ponytail | plugin | none |
| simplify | plugin | none |
| principle-test-behavior-not-implementation | pstack:skills/principle-test-behavior-not-implementation | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| principle-fix-root-causes | pstack:skills/principle-fix-root-causes | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| principle-minimize-reader-load | pstack:skills/principle-minimize-reader-load | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| principle-model-the-domain | pstack:skills/principle-model-the-domain | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| principle-sequence-verifiable-units | pstack:skills/principle-sequence-verifiable-units | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| principle-subtract-before-you-add | pstack:skills/principle-subtract-before-you-add | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| principle-migrate-callers-then-delete-legacy-apis | pstack:skills/principle-migrate-callers-then-delete-legacy-apis | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |
| benchmark-checklist | pstack:skills/benchmark-checklist | 1f0f9c3bac03c4297f6fc8f7644fa412eda57085 |

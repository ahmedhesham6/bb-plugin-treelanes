# Manual setup only

Read this reference only for an explicit manual setup. Normal new tasks use automatic delivery. For a new manual task, assign its target stage with `bb treelanes move <stage>`, then read context. Keep an existing Design Gate until its required decisions are accepted.

For this manual path, read `bb treelanes catalog` and `bb treelanes playbooks`. The harness is the BB provider, saved as `execution.providerId`. Use prior checked setups as examples, then check the current request and files. Prior success grants no approval and does not validate new work. Read `bb treelanes catalog <provider-id> <skill-query>` for the live models, effort levels, and relevant skills. Choose from that catalog. Respect the user's model or harness choice. Use a small model and low effort for clear, bounded work when it can meet the checks. Use more effort or a stronger model when the task needs it. Give a short reason based on the task, uncertainty, and needed checks. Do not infer support or substitute a default.

Save `setup` with a short `summary` and the smallest complete `steps` list. A step has this shape; replace the sample choice with exact live catalog values:

```json
{"id":"fix","title":"Fix the reported bug","stage":"tdd","instructions":"Fix the accepted regression through the public API.","checks":["focused regression"],"execution":{"providerId":"catalog-provider-id","model":"catalog-model-id","reasoningLevel":"low","skills":["catalog-skill-id"],"reason":"A bounded fix with an accepted interface and a focused check."}}
```

Use unique stable IDs and one to 24 steps. Stages are `tdd`, `quality`, `simplify`, and `pr`. Several steps can share a stage. The first step matches the assigned stage, or follows Design after its receipt. PR can only be last. Each other step needs at least one clear check. Include review or cleanup when the task, repository rules, or findings require it. A task with an explicit local-only limit may end after one checked step; PR-targeted tasks keep PR Watch last. Put a check needed only once in that step's `checks`; keep explicit common requirements in `requiredChecks`. Optional `stageChecks` adds exact check names to all steps in that stage. Never remove a required check to make work pass.

Save the task, read context again, then call `bb treelanes start` once to dispatch the first step. A saved Design task must pass its Design Gate first. The board resolves the chosen execution settings, stores them before launch, and returns `execution.selectedSkills` references through board context. The SDK does not restrict the worker's tool set or expose a skills launch field. Keep existing permission limits.


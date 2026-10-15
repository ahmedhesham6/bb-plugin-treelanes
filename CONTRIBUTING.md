# Contributing to Treelanes

Thank you for your help. Bug reports, fixes, docs and new ideas are welcome.
Everyone in this project follows the [code of conduct](CODE_OF_CONDUCT.md).
To report a security problem, read [SECURITY.md](SECURITY.md).

## Before you start

- For a bug, open an issue with the bug report form.
- For a large change, open an issue first, so that we agree on the approach
  before you write code.
- Read [CONTEXT.md](CONTEXT.md). It defines the words that the code and docs
  use, such as Worktree Card, Saved Task and Settled Thread. Use the same
  words in code, tests, docs and pull requests.

## Set up

You need Node.js 24, npm, and bb 0.43 or later.

```sh
git clone https://github.com/ahmedhesham6/bb-plugin-treelanes
cd bb-plugin-treelanes
npm install
npm test
npm run typecheck
npm run build
```

Set up is done when the last three commands pass. CI runs the same three
checks on each pull request.

## Try a change in bb

```sh
bb plugin install .
bb plugin dev
```

`bb plugin dev` builds the plugin again and reloads it each time that you save
a file. Treelanes reads and changes board and sidebar data, so use a bb that
has no data that you need.

## Find your way

Each `*.test.ts` or `*.test.tsx` file sits next to the code that it tests.

```text
.
├── server.ts               # plugin backend: board state, RPCs, CLI, agent tools, recovery
├── app.tsx                 # board panel, thread pane, app slot registration
├── workflow.ts             # stage IDs and labels
├── stage-evidence.ts       # Saved Task and Completion Receipt schemas, worktree digest
├── stage-prompts.ts        # stage worker prompts
├── delivery-plan.ts        # deliveryStages and check rules
├── setup-plan.ts           # Task Setup schema and revision rules
├── setup-request.ts        # setup proposals and the setup prompt
├── setup-automation.ts     # Setup Requests: planning and dispatch
├── step-execution.ts       # Execution Choice checks against live catalogs
├── stage-continuation.ts   # continuation after a turn with no receipt
├── tdd-repair.ts           # repair continuation
├── thread-retry.ts         # Same-thread Retry
├── task-kinds.ts           # task kind templates and skill IDs
├── task-map.ts             # task map choices, planner rule, catalog check
├── task-map-settings.tsx   # task map Settings section
├── import-data.ts          # bb treelanes import
├── marketplace.json        # store listing; its overview copies PLUGIN_OVERVIEW.md
├── plugin-id.ts            # plugin ID from package.json
├── sidebar/                # sidebar: thread list, lifecycle, titles
├── components/ lib/ hooks/ # shared UI parts
├── skills/                 # shipped skills; SOURCES.md maps each source
├── scripts/sync-skills.sh  # updates the copied skills
└── docs/                   # delivery rules, README and store images
```

## Make a change

- Keep each pull request to one change.
- Add or change a Vitest test for each change in behavior.
- Edit only the skills that Treelanes owns.
  [skills/SOURCES.md](skills/SOURCES.md) names them and tells how copied
  skills update.
- Write commit messages in the
  [Conventional Commits](https://www.conventionalcommits.org) form, for example
  `fix: keep a snoozed thread hidden after reload`.

## Open a pull request

1. Fill in the pull request template. It follows the
   [visual-pr](https://github.com/humanlayer/skills/tree/main/plugins/visual-pr)
   format from HumanLayer: a one-sentence reason, short reviewer notes, and a
   change outline in small visual views.
2. For a change that you can see in bb, add a screenshot.
3. Wait for CI to pass.

## License

Treelanes uses the [MIT license](LICENSE). When you send a contribution, you
agree that it uses the same license.

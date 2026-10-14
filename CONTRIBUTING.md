# Contributing to Treelanes

Thank you for your help. Bug reports, fixes, docs and new ideas are welcome.

## Before you start

- For a bug, open an issue. Give the bb version, the Treelanes version, the
  steps, and what you saw.
- For a large change, open an issue first, so that we can agree on the
  approach before you write code.
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

## Try a change in bb

```sh
bb plugin install .
bb plugin dev
```

`bb plugin dev` builds the plugin again and reloads it each time that you save
a file. Treelanes reads and changes board and sidebar data, so use a bb that
has no data that you need.

## Make a change

- Keep each pull request to one change.
- Add or change a test for each change in behavior. Tests use Vitest and sit
  next to the code that they test.
- Do not edit a copied skill in `skills/`. Read
  [skills/SOURCES.md](skills/SOURCES.md) first. It tells you which skills
  Treelanes owns and how to update a copy.
- Write commit messages in the
  [Conventional Commits](https://www.conventionalcommits.org) form, for example
  `fix: keep a snoozed thread hidden after reload`.

## Open a pull request

1. Make sure that `npm test`, `npm run typecheck` and `npm run build` pass.
2. Tell what the change does and why.
3. For a change that you can see in bb, add a screenshot.

## License

Treelanes uses the [MIT license](LICENSE). When you send a contribution, you
agree that it uses the same license.

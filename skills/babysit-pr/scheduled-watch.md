# Scheduled watch

Use this when the harness can run a script on a schedule but cannot keep a process alive between turns, such as a bb automation.

Schedule a **script** that runs `watch.py --once` and forwards its output to the agent. `--once` prints one line only when the PR changed since the baseline and the agent has not already been told. When nothing changed it prints nothing, so a quiet tick costs no model turn. Schedule the script, never an agent prompt: an agent turn on every tick reloads the whole context to learn that nothing changed.

bb example, every 2 minutes. Replace the paths, PR, thread and project:

```sh
out=$(python3 /path/to/babysit-pr/watch.py https://github.com/OWNER/REPO/pull/1234 --once) || true
[ -n "$out" ] && bb thread tell <thread-id> "$out. Run /babysit-pr from step 1, then run watch.py --baseline." --mode queue
```

Read `bb automation create --help` for the current flags.

- Keep the baseline step from the skill: the agent runs `watch.py --baseline` at the end of every pass. Without it, the change is reported again every `--renotify` minutes (default 60).
- `--once` prints `ERROR` only after five failed reads in a row, so a short GitHub outage stays quiet.
- When the PR merges or closes, the script reports it once. The agent then pauses or deletes the automation.

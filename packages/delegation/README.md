# specpi-delegation

Bounded in-house subagents for [Pi](https://pi.dev). The agent hands a question to a real Pi child session that can read a frozen copy of selected sources and nothing else, then reports back under fixed call, token and time ceilings.

This is the first-party replacement for third-party subagent packages in SpecPi's default base. It trades breadth for a boundary you can state in one sentence: a child can read what you selected, when you selected it, and can do nothing else.

## Install

```
pi package add npm:specpi-delegation@0.1.0
```

Pi supplies every runtime import. The package has no production dependencies.

## Use

Delegation is **enabled at Pi startup** whenever a session has a model configured; there is no opt-in step. Turn it off for a session with:

```
/delegate off
```

While it is on, the agent has a `delegate` tool with two job modes:

- **review** — check finished artifacts against assigned requirements in fresh context, with no memory of how the work was argued for.
- **scout** — answer one distinct evidence question over selected sources.

`run` returns immediately and `collect` waits, so the parent can keep working while children run. A child's result is advisory evidence, not a verification: it never grants permission and never proves a task is complete.

### Command

| Command                    | Effect                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `/delegate off` / `on`     | Turn delegation off or back on for this session (on at startup)     |
| `/delegate status`         | Current posture, model, guard state and session counters            |
| `/delegate limits`         | The ceilings currently in force                                     |
| `/delegate budget <1–64>`  | Save a session budget multiplier (default 8); `reset` restores it   |
| `/delegate timeout <1–60>` | Save a per-job timeout in minutes (default 10); `reset` restores it |
| `/delegate cancel <id>`    | Cancel a running job or batch                                       |

Saved budget and timeout live in `<pi-agent-dir>/specpi/delegation/settings.json`.

## What a child can do

Exactly three tools, against a snapshot taken when the batch starts:

- `list_sources` — page through the selected sources
- `read_source` — read numbered lines from one selected source
- `search_sources` — search within the selection

No shell, no edits, no network, no nested delegation, and no access to any tool the parent registered. A path outside the selection is refused.

## Ceilings

Local settings may lower these and never raise them:

| Limit           | Value                          |
| --------------- | ------------------------------ |
| Concurrent jobs | 2                              |
| Jobs per batch  | 2                              |
| Request packet  | 256 KiB                        |
| Result per job  | 16 KiB                         |
| Snapshot        | 200 files / 8 MiB              |
| Response page   | 16 KiB                         |
| Job timeout     | 10 minutes (configurable 1–60) |
| Session budget  | 8× (configurable 1–64)         |

## Boundaries worth knowing

Child sessions are a capability restriction, not an OS sandbox — they run as the same user in the same process tree. A delegated result is model-generated text and carries no prompt-injection defense; treat it as untrusted input. Changing model, provider, thinking level or working directory invalidates an active grant rather than carrying it forward silently.

[SECURITY.md](SECURITY.md) states the full boundary.

## License

MIT

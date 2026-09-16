# specpi-experiments

Bounded detached Git worktree experiments for [Pi](https://pi.dev). Try an idea in an isolated worktree, then export it as a patch or discard it — without ever touching the worktree you are working in.

## Install

```
pi package add npm:specpi-experiments@0.1.0
```

Pi supplies every runtime import. The package has no production dependencies.

## Why

"Let me just try something" usually means editing the working tree and hoping you can get back. An experiment instead gets its own detached worktree at the current `HEAD`, so the base worktree, its index, and its uncommitted changes are never in play. When the experiment answers its question, you export a patch or throw the whole thing away.

## Use

```
/experiment start [name]
```

Opens an editor with an experiment card — name, hypothesis, acceptance, non-goals. If a task contract is present in the session it prefills the card; otherwise the card starts blank. Confirming creates a detached worktree from `HEAD` and reports its path. **Open a separate Pi session in that directory to do the work** — the experiment is a place to work, not a background agent.

| Command                    | Effect                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `/experiment start [name]` | Write a card and create a detached worktree at `HEAD`                                |
| `/experiment status [id]`  | Changed, committed, untracked and ignored path counts, plus the acceptance you wrote |
| `/experiment close [id]`   | Export a patch or discard the worktree and its record                                |
| `/experiment recover`      | Reconcile records against what Git actually tracks                                   |

Experiments live under `<pi-agent-dir>/specpi/experiments/`, in a registry guarded by a lock file, with worktrees in a private directory. At most 32 are retained.

### Starting dirty

If the base worktree has uncommitted changes, `start` says so and asks before continuing. Those changes stay where they are: the experiment starts from `HEAD`, so dirty paths are **not** copied into it.

### Closing

`close` offers a patch export or a discard. Export writes a patch of the experiment's work; it refuses to replace an existing destination or follow a symlink, including one that appears between the check and the write. Discard removes the worktree and its record. Ignored paths are reported by `status` but are not exportable — a patch will not carry them.

### Recovery

Worktrees outlive processes. `recover` walks the registry against `git worktree list` and offers, per finding, to activate a record Git still tracks, forget a record whose worktree is gone, or release a record while leaving an orphan directory in place for you to inspect. It never deletes a directory Git still tracks.

## Boundaries worth knowing

An experiment worktree is an ordinary directory on your disk, with your permissions — isolation is from your _base worktree_, not from your machine. Only one experiment operation runs at a time, because `git worktree` is not safe to run concurrently against one repository. Git reports paths verbatim, so path labels are percent-encoded before display; a filename containing a newline cannot forge a line of output.

[SECURITY.md](SECURITY.md) states the full boundary.

## License

MIT

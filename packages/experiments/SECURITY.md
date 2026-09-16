# Experiments security boundaries

This package is trusted host code running with Pi's privileges. A detached worktree is **isolation from your base worktree, not from your machine**. It is an ordinary directory owned by you, readable and writable by any process running as you, and anything Pi can do in your project it can do there. Do not treat an experiment as a sandbox for untrusted code.

Experiment state lives under `<pi-agent-dir>/specpi/experiments/`. The registry, its lock and the worktree parent are created with `0o700` and refuse to operate through a symbolic link; on Windows those permissions are inherited from the profile rather than enforced by mode bits. Registry writes are atomic — staged to a temporary file and renamed — and serialized behind a lock file, so a crashed operation leaves either the old registry or the new one, never a partial record.

Only one experiment operation runs at a time. `git worktree` is not safe to run concurrently against the same repository, and a second `/experiment` invocation is refused while one is active rather than queued.

Experiments never write to the base worktree or its index. `start` creates a detached worktree at `HEAD`, so uncommitted changes in the base worktree are neither copied nor modified; `status` measures against the experiment's own `HEAD`. A failed worktree creation leaves a `prepared` record for `/experiment recover` rather than a half-registered experiment.

Patch export refuses to replace an existing destination and refuses to write through a symbolic link, re-checking immediately before the write so a destination that appears after the check is not silently replaced. Patches are bounded to 32 MB. Ignored paths are counted by `status` but never exported, so a patch cannot carry build output or local secrets from an ignored directory. Export destinations may be anywhere you can write; this is a no-clobber guarantee, not filesystem confinement.

`recover` never deletes a directory Git still tracks. Releasing an orphan record leaves the directory in place and says so. Forgetting a record removes only the registry entry.

Git reports paths verbatim, including newlines and bidirectional control characters. Path labels are percent-encoded before display so a crafted filename cannot forge a line of output or reorder what you read. Card text is NFKC-normalized, stripped of control characters and truncated; at most 32 experiments and 200 ignored paths are retained per record.

Experiment cards, status output and patch paths cross Pi's conversation and model-provider boundary. Use the same care with experiment content as with any project content.

Top-level dependencies are none; Pi supplies every runtime import as an optional peer. The bundled Pi manifest loads only `src/index.ts`, so no other file in the package is auto-discovered as an extension.

Report vulnerabilities privately using the SpecPi repository's security reporting process: https://github.com/TannerMidd/SpecPi/security/advisories/new

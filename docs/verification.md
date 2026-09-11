# Verification gates

A completion challenge records what the model says it verified. A verification gate records what actually ran. This page describes the ledger that holds the second kind of record and how a challenge uses it.

Verification is inactive until a human declares gates. With no `.specpi/checks.json`, `/challenge` behaves exactly as it did before, and `run_check` refuses every call.

## Declaring gates

Create `.specpi/checks.json` in the project root:

```json
{
    "schema": 1,
    "gates": {
        "check": {
            "command": "npm",
            "args": ["run", "check"],
            "windows": { "command": "cmd.exe", "args": ["/c", "npm", "run", "check"] }
        },
        "unit": { "command": "node", "args": ["--test", "tests/"], "timeoutMs": 300000 }
    }
}
```

A gate runs the named program directly through an argument array. No shell interprets it, so pipes, redirections, globs, and variable expansion are inert text rather than syntax. Name a shell explicitly if a gate genuinely needs one, and understand that you are then approving that shell's parsing of the arguments you supplied.

| Field | Required | Meaning |
| --- | --- | --- |
| `command` | yes | Program to execute, up to 240 bytes |
| `args` | no | Up to 24 arguments, 240 bytes each |
| `windows` | no | Replaces `command` **and** `args` on Windows; no other field |
| `cwd` | no | Project-relative working directory; must stay inside the root |
| `timeoutMs` | no | 1,000–900,000 ms, default 300,000 |
| `label` | no | Human description, up to 120 bytes |

### Windows and batch scripts

Gates spawn without a shell, and Node refuses to start a `.cmd` or `.bat` that way. On Windows `npm`, `npx`, `yarn`, and `pnpm` are all batch scripts, so a gate naming one is rejected when the configuration is read rather than failing with an opaque spawn error on the first call.

Reach them through an explicit interpreter, which is why `windows` replaces the arguments as well as the program:

```json
"windows": { "command": "cmd.exe", "args": ["/c", "npm", "run", "check"] }
```

`cmd.exe /c` does parse what follows it. That parsing is part of what you are approving, and the confirmation prompt shows the whole invocation. A gate whose program is a real executable on every platform — `node`, `python`, `cargo`, `go` — needs no override at all.

Gate IDs match `^[a-z][a-z0-9-]{0,31}$`, and a project declares 1–16 of them. The file must be a bounded regular file of at most 16 KiB, not a symlink. A present-but-unusable file is an error rather than a silent fallback to inactive, because an unverified session must not look like one where no gates were ever declared.

Gates are declared by a human. The model may cite a gate ID and ask for a gate to run; it cannot define one, change one, or introduce a gate that trivially passes.

## Running gates

```text
/verify status         Show each declared gate and its current ledger state
/verify run <gate>     Run a gate yourself
/verify clear          Discard the ledger for this session branch
/verify reload         Re-read .specpi/checks.json
```

The model runs a gate through the `run_check` tool. A model-initiated run is confirmed once per gate spelling per approval generation, and every time under Strict Guard; a Guard policy change retires cached approvals. `/verify run` needs no separate confirmation, because naming the gate is the approval. Command Guard reports policy only: there is no command string for its rules to parse, so the confirmation names the exact executable, arguments, working directory, and timeout instead.

One gate runs at a time, including while another gate's approval is pending. A gate inherits your permissions and environment and is not sandboxed. Its output reaches the transcript, capped at the last 4,000 characters with control characters stripped.

A gate that times out, is cancelled, or is killed by a signal reports no usable exit code and is recorded as exit 1, which resolves as `failed`. That direction is deliberate: an unclear outcome can never prove a requirement. Read the recorded output to tell a genuine failure from an interrupted run.

## What a record contains

Each run appends one record, and a re-run supersedes its predecessor, so the ledger holds at most one record per declared gate:

| Field | Source |
| --- | --- |
| `gate`, `command`, `cwd` | the declaration |
| `exitCode` | the process, observed by the harness |
| `digest`, `paths`, `fingerprints` | a worktree snapshot taken after the process exits |
| `startedAt`, `durationMs` | the harness clock |

Nothing in that table is model-supplied. The snapshot covers every path `git status` reports as changed, fingerprinted by content hash, and is taken after the gate exits so it includes anything the gate itself wrote.

Records live on the session branch. They are bound to the worktree root they were taken against, so a branch restored under a different root contributes nothing.

## How a gate resolves

At challenge time each gate is compared against the worktree as it stands:

| State | Meaning |
| --- | --- |
| `proven` | Exit code 0, and the worktree is byte-identical to the one the gate finished on |
| `stale` | Exit code 0, but files changed afterwards; the report names them |
| `failed` | Nonzero exit code |
| `unavailable` | The gate was never run in this session branch |
| `indeterminate` | The snapshot could not be taken, or more than 256 paths changed |

`stale` is the state worth understanding. A check that passed and was then invalidated by a later edit is not weaker proof than one that never ran — it is proof of something that no longer exists. A gate is re-resolved when the challenge submission arrives, not only when the prompt was built, so an edit made between the two is caught.

## How a challenge uses the ledger

Each requirement assessment may cite up to eight gate IDs. The requirement inherits the worst state among the gates it cites, in the order `failed`, `unavailable`, `stale`, `indeterminate`, `proven`.

While verification is active:

- A requirement marked `proven` must cite at least one gate, and every gate it cites must currently resolve `proven`. A claim the ledger does not support is rejected with the reason.
- A requirement marked `partial` or `unproven` may cite nothing.
- Citing an undeclared gate is rejected.
- A ready-for-human-review verdict requires every requirement to be backed by a current passing gate, in addition to the checks that already applied.

The model's own status stays on the record beside the harness's resolution, so a disagreement between them is visible rather than resolved silently in either direction.

## Limits

A gate proves that a specific command exited zero against a specific worktree. It does not establish that the command checks the right things, that its assertions are meaningful, or that the requirement citing it is genuinely covered. Choosing gates that test what matters remains a human judgment, and the prose in a completion challenge remains model-authored.

Snapshots cover on-disk bytes reported by `git status`. Unsaved editor buffers, files outside the repository, and changes made by another process during a run are outside that boundary. Beyond 256 changed paths a snapshot is indeterminate and cannot prove anything. A gate executes a trusted program with your permissions; these controls bound what is recorded, not what a hostile program could do.

## Development verification

```sh
node --test tests/verification-ledger.test.mjs
node extensions/workflow-controls/smoke.mjs verification-ledger-smoke
```

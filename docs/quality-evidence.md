# Review and verification evidence

SpecPi keeps planning, model review and runtime observations distinct. The user chooses which checks matter; a model's statement that a test passed cannot create a runtime receipt.

## Review a selected change

Invoke `/skill:specpi-review` with a selected diff, commit, patch or files. Choose `correctness`, `simplicity`, or `both` (the default). The skill asks for concrete findings with a file, failure trigger, impact and smallest remedy. It examines callers and existing helpers, preserves intentional public interfaces and security boundaries, and reports missing context instead of inventing proof.

The skill is hidden from Pi's automatic skill selection (`disable-model-invocation: true`). It reports findings without editing. This is an instruction to the model, not an OS read sandbox. Applying findings is a separate user-directed task. It does not start an advisor, memory service or swarm.

## Run a finite check

Ask Pi to call `verify_run` with the exact command and its relevant source, test and configuration inputs. For example, in a small JavaScript repository:

```json
{
    "command": "npm test",
    "label": "Unit tests",
    "timeoutSeconds": 120,
    "inputs": ["src/", "tests/", "package.json", "package-lock.json"]
}
```

Only declare files that exist. Include the configuration and lockfiles that actually affect the check. Inputs are relative to the Git project root, or the current directory outside Git. A trailing `/` declares a recursive directory inventory, including initially clean files and newly added files. Other entries declare exact files. Globs, traversal, directory links, hard-linked files, private state, credential filenames, dependency trees and oversized inventories are rejected. Narrow the input selection when a directory contains excluded material; disclose the resulting coverage limit.

The approval shows the shell, cwd, exact command preview, timeout, Guard decision, input declarations and initial snapshot digest. It grants that exact execution and input snapshot for the session. Commands run with the user's permissions and inherited environment through the existing background runner: system `cmd.exe` on Windows and `/bin/sh` on POSIX. They can have side effects. Neither approval nor a receipt certifies that a script is harmless.

`verify_run` waits for an observed terminal outcome. It shares the four active process slots, lifecycle cleanup and Guard admission with background tasks. Cancellation, timeout, nonzero exit, launch failure and unconfirmed cleanup remain explicit. A policy change, branch navigation, session replacement or reload invalidates live receipts. `background_stop` remains available to retry cleanup under a Guard lock.

| Bound | Limit |
| --- | --- |
| Declared files or directories | 40 |
| Expanded files / scanned entries / depth | 256 / 512 / 12 |
| Total input bytes | 8 MiB |
| Live receipts | 32, oldest evicted |
| Returned output tail | 16 KiB after control escaping |
| Timeout | 30 minutes by default; 8 hours maximum |

A receipt includes the execution-spec digest, canonical project root, before/after file hashes, exit code/signal, elapsed time, cleanup outcome and a bounded untrusted output tail. Separate SHA-256 digests cover observed raw stdout/stderr bytes even when their displayed tail is truncated. They do not prove all command output was observed. Receipt data stays in extension memory, but returned tool content can enter Pi conversation and provider retention.

The registry re-enumerates and hashes declared inputs when evidence is consumed. Changes during or after the command, missing inputs or exceeded limits make evidence stale. This is a snapshot check, not continuous monitoring: transient change-and-restore races, undeclared dependencies, inherited environment, external services and test quality are outside its proof.

## Choose required checks for a task

1. Set the task's original requirements with `/task set`.
2. Run the desired checks using `verify_run`.
3. Open `/task checks` and select current receipt IDs in its JSON editor. For example:

```json
[
    {
        "id": "C1",
        "label": "Unit tests",
        "receiptId": "the-receipt-id-returned-by-verify_run",
        "requirementIds": ["R1", "R2"]
    }
]
```

Submit `[]` to clear required checks explicitly. Up to eight checks can be selected. A failing check can be selected: declaring a gate does not claim it has passed. The contract stores stable check IDs, labels, execution digests, input declarations and exact original requirement IDs. It does not persist the live receipt registry. Changing requirements cannot silently detach existing checks; revise the check selection deliberately.

`/challenge` uses the latest matching live receipt for each selected check and re-hashes inputs at submission. An older pass cannot hide a newer failure, including a cancelled rerun in the same session. A requirement linked to a missing, failed or stale required check cannot be marked proven, and readiness requires every declared check to pass. Wrong tool registration, ambiguous registry responses, changed task digests and unknown receipt IDs fail closed. Free-form evidence and legacy tasks remain model assessments.

`/task handoff` includes revalidated check status and labels saved review verdicts as historical. Restoring a conversation cannot turn a saved receipt summary into live evidence. Rerun the same command, cwd, shell, timeout and input manifest after restoration, or explicitly choose a revised check. Schema-1 task cards keep their original digests and have no required checks; newly authored cards use schema 2.

These checks operate between trusted SpecPi extensions. Tool provenance and an in-memory registry prevent model text from impersonating runtime evidence; they do not isolate a malicious extension with full access to the same process.

## Editor context

In a connected SpecPi Chat conversation, use **SpecPi: Attach Diagnostics to Chat**, **Attach References to Chat**, or **Attach Definition to Chat**. Diagnostics use explicitly selected files. References and definitions use the active editor's symbol position. The commands also appear in the editor context menu.

Results enter the ordinary attachment draft and open a plain-text preview. Up to eight files, 100 results and 16 KiB are included. Source/code/severity/range, collection time, open-buffer version and unsaved state are recorded. Unsupported, external and sensitive locations are excluded. Existing providers may be activated; none are installed automatically. Provider timeout or no result is disclosed, and cached empty diagnostics are not a successful typecheck.

Sending checks the selected workspace, conversation token and file/buffer identity again. If a buffer changed, remove and re-collect that attachment. Unsaved buffers are never saved automatically. Results are plain untrusted text: diagnostic links and command URIs are not followed. There is no additional RPC method, network listener, language server or writable language tool.

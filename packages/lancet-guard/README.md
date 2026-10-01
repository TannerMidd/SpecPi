# specpi-lancet-guard

A local, CPU-only command guard for [Pi](https://pi.dev). Before a shell command runs, [LANCET Nano](https://github.com/TannerMidd/LANCET-model) v0.4.3 scores it on your machine: a 111M-parameter CodeT5+ 220M encoder, fine-tuned to flag risky Bash, PowerShell and cmd commands, running as INT8 ONNX. No API key, no account, and no network once the model is downloaded.

It is off until you turn it on.

## Install

```
pi install npm:specpi-lancet-guard@0.6.0
```

SpecPi installs it by default. The package carries code only; the model is fetched once, by you:

```
/lancet-guard setup
```

Setup downloads the release ZIP (about 109 MB) from the pinned [LANCET-model GitHub release](https://github.com/TannerMidd/LANCET-model/releases/tag/v0.4.3), refuses it unless its SHA-256 matches the digest built into this package, extracts only the six model files (the encoder, its pooling head, the tokenizer and the thresholds; 116 MB on disk) and checks each against its own digest. It then runs two sample commands and asks whether to turn the guard on: for this session, or saved for future ones.

Each package release accepts exactly one model. After updating from an earlier version, run `/lancet-guard setup` again to fetch v0.4.3: until you do, a guard you saved as on blocks what the local rules leave open, as it does whenever the model is missing. Older models stay in `<pi-agent-dir>/lancet-guard/` (for example `lancet-nano-v0.4.2-int8/`) and are no longer used; you can delete those folders.

## Use

| Command                                    | Effect                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `/lancet-guard`                            | Status: on or off, saved setting, model state                   |
| `/lancet-guard setup`                      | Download and verify the model, self-test, offer to turn it on   |
| `/lancet-guard on` / `off`                 | Switch it for this session                                      |
| `/lancet-guard on --global` / `off --global` | Switch it and save that as the default for future sessions    |
| `/lancet-guard mode <ask\|block>`          | Choose what a `risky` verdict does, saved for future sessions (see [Modes](#modes)) |
| `/lancet-guard check <command>`            | Score a command without running it                              |
| `/lancet-guard audit <transcript\|status\|off>` | Where decisions are shown; every one is still written to the session file |

`on` is refused until the model is installed, because an armed guard with no model blocks every command the rules leave open.

## How it decides

For `bash`, `powershell` and SpecPi's `background` tool:

1. **Local rules first**, the same ones specpi-jev-guard uses: hard-deny patterns (recursive deletion of `/`, a home or system directory, `mkfs`, raw device writes, `curl | sh`, fork bombs…) block; provably read-only commands (`ls`, `git status`, `rg` with read-only flags…) pass; your `safeCommands`, `allowedCommands` and `disallowedCommands` globs apply. LANCET cannot overrule these.
2. **LANCET scores the rest.** `risky` asks you, or blocks in block mode; `review`, Nano's band for commands it is unsure about, always asks; `not_flagged` runs.
3. **What LANCET cannot read or clear asks.** It reads Bash, PowerShell and cmd: `bash` and `background` calls are scored as Bash, `powershell` calls as PowerShell, so a PowerShell command it does not flag now runs instead of asking. Commands over 8,192 bytes ask. A command longer than one 512-token window is read in full, as overlapping windows, but LANCET never clears it: `risky` and `review` act as usual, and `not_flagged` asks, as every command that long did before v0.4.3 (see below).

For `write` and `edit`, LANCET is not involved: ordinary project files pass, and protected paths (`.env*`, keys, `.ssh`, `.git`, `node_modules`) or anything outside the workspace ask.

### Modes

`/lancet-guard mode` chooses between two modes and saves the choice as `risky` in `~/.pi/lancet-guard.json`:

- **ask** (the default): `risky` and `review` both ask.
- **block**: `risky` is blocked outright and, as with the hard-deny rules, Pi stops the agent once that batch of tool calls finishes; `review` still asks. Fewer prompts, at the cost of a safe command LANCET misjudges being blocked and stopping the run.

The mode covers LANCET's verdicts only. In both, the local hard-deny rules and your `disallowedCommands` block, and so does a missing or damaged model (see below). A trusted project's `.pi/lancet-guard.json` can set its own `risky`, which wins inside that project; `/lancet-guard mode ask` or `block` says so when it does.

With no UI to ask (print or RPC mode without a client), an "ask" becomes a block unless you set `"uncertain": "allow"`.

**It fails closed.** A missing or damaged model, or ONNX Runtime failing to load, blocks the commands the rules leave open. `/lancet-guard off` switches it off.

`not_flagged` means LANCET did not flag it, not that it is safe. The permission system and your own judgement still apply.

## Settings

`~/.pi/lancet-guard.json`, with a trusted project's `.pi/lancet-guard.json` on top:

```json
{
    "enabled": false,
    "risky": "ask",
    "uncertain": "ask",
    "auditDisplay": "status",
    "safeCommands": [],
    "allowedCommands": [],
    "disallowedCommands": [],
    "protectedPaths": ["**/.env*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/.ssh/**", "**/.git/**", "**/node_modules/**"]
}
```

## What to expect

These figures come from LANCET's v0.4.3 release evaluation: the classifier alone, before the local rules, each benchmark scored once at the shipped thresholds. None of the three was used to train, tune or calibrate v0.4.3.

| | Nano v0.4.3 (this guard) | Nano v0.4.2 | Jev (hosted, the old guard) |
| --- | ---: | ---: | ---: |
| Triage Score, three benchmarks (7,911 commands) | 68.3 | 54.4 | 38.9 |
| lancet-bench-2-next (3,204): risky commands caught | 78.0% | 78.0% | 95.1% |
| lancet-bench-2-next: safe commands wrongly stopped | 12.4% | 20.0% | 21.8% |
| lancet-bench-2-next: risky commands blocked outright (Nano's `risky` band) | 50.0% | 17.7% | 62.0% |
| ShellRisk-Bench test (4,194): caught / stopped | 64.8% / 3.0% | 60.1% / 2.7% | 67.9% / 20.9% |
| Neutral set (513): caught / stopped | 85.8% / 5.6% | 91.0% / 7.0% | 97.2% / 30.2% |

The Triage Score gives a point for each risky command asked about or blocked, and scales the total down in proportion when more than 10% of safe commands are stopped; the three benchmarks are weighted by size. lancet-bench-2-next replaces lancet-bench-1, the 793-command Bash benchmark earlier releases of this guard reported. It is built as 1,602 risky/safe twins from 289 scenarios in 40 areas, each repeated inside subshells, functions, pipelines and other wrappers, in Bash (3,066 commands), PowerShell (102) and cmd (36). It is much harder, so every guard scores lower on it: v0.4.2 caught 92.4% of lancet-bench-1's risky commands and 78.0% of these. lancet-bench-1 was retired and used to train v0.4.3, so it no longer gives a fair figure.

On lancet-bench-2-next, v0.4.3 catches what v0.4.2 did while stopping far fewer safe commands: about one in eight, against one in five. It is also more decisive: half of the benchmark's risky commands come back `risky`, which asks (or blocks, in block mode), against 17.7% for v0.4.2, which put most of what it caught in `review`, which always asks. On ShellRisk-Bench it catches more at about the same rate of safe commands stopped; the neutral set is the one place it gives ground.

- lancet-bench-2-next is LANCET's own benchmark, kept private so it stays unseen, so this is diagnostic evidence, not independent acceptance. ShellRisk-Bench is labelled upstream and the neutral set comes from outside parties. Jev also saw task context; Nano sees only the command.
- PowerShell and cmd are new in v0.4.3 and less covered than Bash, in training and in the benchmark. Its weakest areas on lancet-bench-2-next are credentials, Windows administration, macOS administration and deceptive previews. The local rules and the permission system still apply.
- Padding dilutes. Harmless lines in front of a risky command lower its score. Checked here with the nine risky Bash commands of the parity fixture behind three kinds of harmless lines: while the whole command fits one 512-token window, nearly all fall from `risky` to `review`, which still asks, but one in nine came back `not_flagged` in four of the twelve padded single-window runs; once it spans a second window, anywhere from one to all nine come back `not_flagged`, depending on the padding. That is why the guard asks about any command longer than one window that LANCET does not flag. LANCET's Python runtime gives the same results, so this is the model, not the port.
- About **10 ms** per typical command on a Ryzen 9 3900X (median 9 to 15 ms across runs on a desktop also running other programs, 95th percentile under 30 ms), after a one-off load of about 0.6 s that adds roughly 180 MB of memory. Long commands cost about 0.3 s per full 512-token window: a command of 1,000 tokens takes 0.5 to 1 s, and one at the 8,192-byte limit needs 19 windows and 5 to 8 s. LANCET's Python runtime took the same time as this one, measured side by side. It only loads once the guard is on or you run `check`.
- The runtime is a Node port of Nano's Python `classify.py`, using the same ONNX Runtime release; v0.4.3 brought a new `classify.py` for the windowed format and keeps the CodeT5 tokenizer of earlier releases. On the 76-command parity fixture, recorded with v0.4.3's own runtime on the same machine (Windows x64), the port matches it exactly in token ids, windows and bands, with scores within 6.7e-16. ONNX Runtime's INT8 arithmetic depends on the CPU's instruction set: in CI, v0.4.3's scores were up to 0.015 away from that reference on Apple Silicon and 0.003 on the Linux and Windows x64 runners, and earlier models drifted by up to 0.03 on some x64 CPUs. Every reference command still landed in the same band there, but a command scoring very close to a threshold can land in a different one on a different CPU. That is true of LANCET's own Python runtime too.

ONNX Runtime 1.30.0 ships CPU binaries for Windows x64/arm64, Linux x64/arm64 and macOS arm64. Intel Macs are not supported; there the guard fails closed and should be left off.

LANCET is experimental. It is not a sandbox and does not make running commands safe. [SECURITY.md](SECURITY.md) states the full boundary.

## License

Package code: MIT. The local rules are copied under MIT from specpi-jev-guard. The model is LANCET Nano v0.4.3, Apache-2.0, fine-tuned from Salesforce CodeT5+ 220M (BSD-3-Clause); its release ZIP carries the full licenses, notices and model card. Third-party details: [THIRD_PARTY.md](THIRD_PARTY.md).

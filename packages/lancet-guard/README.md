# specpi-lancet-guard

A local, CPU-only command guard for [Pi](https://pi.dev). Before a shell command runs, [LANCET Nano](https://github.com/TannerMidd/LANCET-model) v0.3.0 scores it on your machine: a 110M-parameter CodeT5-base encoder, fine-tuned to flag risky Bash, running as INT8 ONNX. No API key, no account, and no network once the model is downloaded.

It is off until you turn it on.

## Install

```
pi install npm:specpi-lancet-guard@0.1.0
```

SpecPi installs it by default. The package carries code only; the model is fetched once, by you:

```
/lancet-guard setup
```

Setup downloads the release ZIP (about 100 MB) from the pinned [LANCET-model GitHub release](https://github.com/TannerMidd/LANCET-model/releases/tag/v0.3.0), refuses it unless its SHA-256 matches the digest built into this package, extracts only the three model files (111 MB on disk) and checks each against its own digest. It then runs two sample commands and asks whether to turn the guard on: for this session, or saved for future ones.

## Use

| Command                                    | Effect                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `/lancet-guard`                            | Status: on or off, saved setting, model state                   |
| `/lancet-guard setup`                      | Download and verify the model, self-test, offer to turn it on   |
| `/lancet-guard on` / `off`                 | Switch it for this session                                      |
| `/lancet-guard on --global` / `off --global` | Switch it and save that as the default for future sessions    |
| `/lancet-guard check <command>`            | Score a command without running it                              |
| `/lancet-guard audit <transcript\|status\|off>` | Where decisions are shown; every one is still written to the session file |

`on` is refused until the model is installed, because an armed guard with no model blocks every command the rules leave open.

## How it decides

For `bash`, `powershell` and SpecPi's `background` tool:

1. **Local rules first**, the same ones specpi-jev-guard uses: hard-deny patterns (recursive deletion of `/`, a home or system directory, `mkfs`, raw device writes, `curl | sh`, fork bombs…) block; provably read-only commands (`ls`, `git status`, `rg` with read-only flags…) pass; your `safeCommands`, `allowedCommands` and `disallowedCommands` globs apply. LANCET cannot overrule these.
2. **LANCET scores the rest.** `risky` asks you (or blocks, with `"risky": "block"`); `review`, Nano's band for commands it is unsure about, always asks; `not_flagged` runs.
3. **What LANCET cannot read asks.** It reads Bash only, so PowerShell always asks, as do commands over 8,192 bytes or 512 tokens. Nothing is truncated.

For `write` and `edit`, LANCET is not involved: ordinary project files pass, and protected paths (`.env*`, keys, `.ssh`, `.git`, `node_modules`) or anything outside the workspace ask.

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

These figures come from LANCET's own release benchmark (`lancet-bench-1`, 793 commands, one scoring pass), classifier alone, before the local rules:

| | Nano v0.3.0 (this guard) | Jev (hosted, the old guard) |
| --- | ---: | ---: |
| Risky commands caught | 85.8% | 96.8% |
| Safe commands wrongly stopped | 5.5% | 7.8% |
| Risky secrets commands caught | 66% | 98% |

- The benchmark's labels were written by the LANCET developer, an AI agent, so this is diagnostic evidence, not independent acceptance. Jev also saw task context; Nano sees only the command.
- It is weakest on commands that print or exfiltrate secrets, on network and remote execution, and on infrastructure-as-code. The local rules and the permission system still apply.
- About **23 ms** per command (95th percentile 40 ms) on a Ryzen 9 3900X, after a one-off load of about 0.65 s that adds roughly 275 MB to Pi's memory. It only loads once the guard is on or you run `check`.
- The runtime is a Node port of Nano's Python `classify.py`, using the same ONNX Runtime release. On 7,170 commands on Windows x64 it produced identical token ids and identical bands, with scores within 2.2e-16. ONNX Runtime's INT8 arithmetic is not identical across CPU families: on Apple Silicon, CI measured scores up to 0.03 away from x64. Every reference command still landed in the same band there, but a command scoring very close to a threshold can land in a different one on a Mac than on Windows or Linux.

ONNX Runtime 1.30.0 ships CPU binaries for Windows x64/arm64, Linux x64/arm64 and macOS arm64. Intel Macs are not supported; there the guard fails closed and should be left off.

LANCET is experimental. It is not a sandbox and does not make running commands safe. [SECURITY.md](SECURITY.md) states the full boundary.

## License

Package code: MIT. The local rules are copied under MIT from specpi-jev-guard. The model is LANCET Nano v0.3.0, Apache-2.0, fine-tuned from Salesforce CodeT5-base (Apache-2.0); its release ZIP carries the full licenses, notices and model card. Third-party details: [THIRD_PARTY.md](THIRD_PARTY.md).

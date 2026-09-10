# Structural search

`structural_search` is an opt-in, read-only ast-grep 0.45.3 tool. It matches code structures across formatting changes. It does not resolve types/references, edit code or replace literal search for comments, strings and filenames.

Enable it through the installer, then restart Pi:

```sh
specpi plan --structural-search=on
specpi update --structural-search=on
```

For a fresh installation use `install`. `--yes` confirms installation but does not opt into structural search by itself. Omission preserves the existing choice. `--skip-package-install` and `--skip-tool-install` skip acquisition without disabling an existing runtime. Direct `pi install npm:specpi` does not provision the runtime; use the SpecPi installer for setup.

```json
{
    "language": "typescript",
    "pattern": "pi.registerTool($OPTIONS)",
    "paths": ["extensions/browser/index.ts"],
    "maxResults": 50,
    "timeoutMs": 10000
}
```

JavaScript (`.js`, `.mjs`, `.cjs`), JSX, TypeScript (`.ts`, `.mts`, `.cts`), TSX and Python are supported. Select explicit relative files under the active working root, using ordinary discovery tools first. Directories, globs, custom grammars/configuration and rewriting are unavailable. A pattern with multiple independent statements may be rejected; syntax recovery can also accept malformed patterns, so inspect matches and retain project-native checks.

Limits are 200 files, 8 MiB of selected source in aggregate, 1 MiB per file, 6 KiB encoded path selection, 4 KiB pattern, 100 returned matches, 512 bytes per snippet and 24 KiB per result. Selection metadata must fit half the result budget; narrow long path lists when necessary. The default deadline is 10 seconds, configurable from 1–30 seconds including queueing and approval. There is one active parser and at most one queued request. Raw parser output is capped at 2 MiB, diagnostics at 8 KiB per call. Cleanup may take one additional second; unconfirmed cleanup blocks further parser starts until resolved and the extension is reloaded.

Results include source digests, searched/requested counts, ranges, engine version and explicit truncation. Lines and UTF-8 byte columns are one-based; end positions are exclusive. Columns are calculated from original source bytes, not the CLI's character-oriented display columns. A partial, timed-out, cancelled or unavailable result is not proof that other matches do not exist. Captured on-disk bytes exclude unsaved editor buffers and are not an atomic filesystem snapshot.

The parser receives selected source over stdin, a fixed argument list, a neutral configuration and a minimal environment. It runs from private temporary scratch containing configuration only. Source and results are not written to that scratch. The existing selected-source boundary rejects private namespaces, credentials, path escapes, links and hardlinks. It cannot detect secrets embedded in ordinary source. Returned snippets can persist in normal Pi conversation history.

Guard and Off permit these bounded reads; Strict asks for the exact call. The approval receives the operation cancellation signal and remaining timeout. Terminal prompts dismiss on cancellation; Pi 0.84.4 releases cancelled RPC approvals server-side but sends no remote dismissal event, so clients may display them until the forwarded timeout expires. Late answers cannot authorize the cancelled call. Locked or ambiguous Guard state denies. If Guard is absent, the same source/input limits remain. Policy, root and enablement are rechecked before parsing. A denial must not be retried through a different tool. Existing read-only workers do not gain structural-search access.

Enablement lives in `<agentDir>/specpi/tool-integrations.json`. The installer preserves unrelated fields, backs up the owned file before changes and rolls it back on failure. Serialized configuration must also fit the 16 KiB reader limit: the installer uses compact JSON when needed and rejects output that still exceeds the limit before changing configuration or runtimes. If that file becomes unparseable, `plan` reports it and continues without mutating anything, while `install` and `update` stop and name the file; repair or remove it, or pass `--structural-search=on` or `--structural-search=off` to rewrite it from the backed-up original. A configuration that is a link or not a bounded regular file remains a hard failure that no selection rewrites. The private runtime has an exact npm lockfile, script-free acquisition and binary/full-tree checksums; no global PATH entry is added. Doctor checks integrity and runs an offline fixture smoke. The initial native platforms are Windows x64, macOS x64/arm64 and Linux glibc x64; other combinations report unavailable.

Disable with `specpi update --structural-search=off`, then restart Pi. Intact owned runtimes are removed transactionally. Modified/unverified runtimes are preserved with a warning; replacement preserves them outside the active runtime path. The tree check covers file contents, paths, directories, permissions and link targets without traversing links, and is repeated before retired-tree deletion. Older ownership markers without a tree checksum are unverified and preserved. Rollback quarantines the new runtime and restores the prior directory before recursive cleanup; a cleanup failure reports the retained quarantine path. Uninstall preserves enablement configuration and user evidence. Trusted native executables still run with the user's permissions; these controls are not an OS sandbox.

Development verification uses `npm run setup:structural` followed by `npm run test:structural`. This installs only the locked native test runtime in `.specpi-test/structural-runtime/`. Installer tests use disposable Pi directories and skip external acquisition.

Six synthetic lookup trials on Windows x64 / Node 24.18.0 on September 9, 2026 covered call sites, constructors, filesystem calls, JSX/TSX components and Python calls. Each fixture contained two valid structures with different formatting plus one comment/string decoy. All 12 expected matches were found with no false positives; each response was 669–707 bytes and took 32–48 ms in that single run. A simple fixed-string `rg` query per fixture found six valid matches, missed six formatting variants and returned six decoys (37–85 bytes, 24–33 ms per query). This demonstrates the intended syntax-sensitive use case, not superiority over carefully constructed regex/manual inspection or measured agent productivity. Literal search remains faster and smaller in these trials; structural search remains opt-in.

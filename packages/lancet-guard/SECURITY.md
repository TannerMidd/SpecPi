# LANCET guard security boundaries

This package is trusted host code running with Pi's privileges. It is a **second opinion before a command runs**, not a sandbox: a call it allows runs with your full permissions, and a call it cannot see (anything outside `bash`, `powershell`, `background`, `write` and `edit`) is not gated at all.

## What leaves the machine

Nothing, during use. Commands are scored in-process by ONNX Runtime on the CPU; they are never sent anywhere and never executed by the guard. The only network access is the model download that `/lancet-guard setup` performs when a human runs it: one ZIP from the pinned `https://github.com/TannerMidd/LANCET-model/releases/download/v0.4.0/` release, following GitHub's redirect to its release-asset host. Installing the package, starting a session and switching the guard on download nothing.

## Model integrity

The archive's and the model files' SHA-256 digests and sizes are compiled into `src/model-manifest.mjs`. The ZIP is streamed to a private staging directory, capped at its pinned size, and discarded unless its digest matches. Only then does `src/zip.mjs` read it: it extracts the three named files, inflates each to its pinned size and no further, and refuses encrypted entries, ZIP64 and any compression other than Deflate or stored. Each extracted file must match its own digest. The ZIP is deleted and only a complete, verified set is renamed into `<pi-agent-dir>/lancet-guard/lancet-nano-v0.4.0-int8/`. Every file is verified again each time the model is loaded, so a model directory that is replaced or damaged afterwards fails closed rather than scoring. The release host is a transport, not a trust root: a different model needs a new package release with new digests.

## Defaults and failure

The guard ships **off** and SpecPi never switches it on. It is on only when you run `/lancet-guard on` (this session) or `/lancet-guard on --global` (saved to `~/.pi/lancet-guard.json`), or when a trusted project's `.pi/lancet-guard.json` says so. A trusted project's file can equally switch it off or widen its allow lists, so trust a project only if you trust its configuration.

When on, it fails closed: if the model is missing, fails verification, or ONNX Runtime cannot load, commands the local rules leave open are blocked. With no UI to ask, an "ask" becomes a block unless `uncertain` is set to `allow`.

## Model limits

LANCET is an experimental classifier. `not_flagged` is not a claim of safety. It reads Bash only, sees the command text and nothing else (not the task, not the files it touches), and on its own release benchmark missed about one risky command in nine, and more than a quarter of the risky commands that print or exfiltrate secrets. A command it is unsure about is `review`, which asks. Obfuscated or novel commands may score low. Keep the permission system and your own review in place; this guard adds to them.

## Dependencies

One production dependency, `onnxruntime-node` 1.30.0, pinned exactly. It bundles native CPU binaries for each supported platform. Its install script fetches CUDA libraries from NuGet on Linux x64 only; the guard never uses them, and SpecPi's installer sets `ONNXRUNTIME_NODE_INSTALL=skip` so they are not downloaded. The tokenizer and the ZIP reader are implemented in this package, with no dependency.

Report vulnerabilities privately using the SpecPi repository's security reporting process: https://github.com/TannerMidd/SpecPi/security/advisories/new

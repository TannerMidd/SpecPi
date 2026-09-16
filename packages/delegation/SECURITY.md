# Delegation security boundaries

This package is trusted host code running with Pi's privileges. Child sessions are a **capability restriction, not an OS sandbox**. They run in the same process tree, under the same user, with the same filesystem and network reachability as Pi itself. The confinement described here is enforced by this package's own tool surface, not by the operating system.

Child sessions receive exactly three tools — `list_sources`, `read_source` and `search_sources` — against a snapshot frozen when the batch starts. They cannot write files, run commands, reach the network, spawn further children, or call any tool the parent registered. A child that asks for a path outside its selected sources is refused; the selection is fixed at request time and cannot be widened from inside the child.

The snapshot is a point-in-time copy bounded to 200 files and 8 MiB, restricted to a fixed text-extension allowlist, with each response capped at 16 KiB. Content is read once and reused for the batch, so a child cannot observe edits made after it started. Source freshness is checked against the snapshot digest; a stale batch is reported as `stale` rather than served silently from old bytes.

Child sessions use Pi's own configured authentication through the SDK. This package never reads credential files, never clones the parent's runtime auth overrides, and never inherits parent request hooks or ambient resources. Provider headers are not forwarded, with one exact exception: GitHub Copilot's public catalog identification headers, matched by name and value against a frozen table and rebuilt in the child rather than copied. Any other header shape rejects the model selection.

Work is bounded by fixed ceilings that local settings may lower but never raise: 2 concurrent jobs, 2 jobs per batch, a 256 KiB request packet, a 16 KiB result per job, and a default 10-minute job timeout with an 8× session budget multiplier. Exceeding a ceiling fails the job; it does not silently truncate the parent's view of what happened.

Prompts, source excerpts and results cross Pi's conversation and model-provider boundary, and a child's output is model-generated text that the parent may act on. This package applies no prompt-injection defense. Treat a delegated result as untrusted input, not as a verified finding.

Delegation ships off and stays off until a human turns it on, either for one session with `/delegate on` or for future sessions with `/delegate startup on`, which saves the choice to this package's own settings file. An absent, malformed or unreadable preference reads as off. While it is off no tool is offered to the model and no child session can be requested at all. Once a saved preference enables it, activation happens at startup in every mode including RPC and print, preflighting the host without launching workers or model inference; a session whose model, provider, thinking level or working directory changes has its grant invalidated rather than silently carried forward. Enabling by command requires an interactive session; startup activation does not.

This package cooperates with a command guard when one is present, through the `specpi:guard-state` and `specpi:guard-policy-changed` events, and reports its guard posture as `absent` when none answers. SpecPi no longer ships a command guard, so the default posture is `absent`: delegation admission is governed by the host's permission system and the human on/off toggle alone.

Top-level dependencies are none; Pi supplies every runtime import as an optional peer. The bundled Pi manifest loads only `src/index.ts`, so no other file in the package is auto-discovered as an extension.

Report vulnerabilities privately using the SpecPi repository's security reporting process: https://github.com/TannerMidd/SpecPi/security/advisories/new

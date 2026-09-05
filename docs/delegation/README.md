# Bounded delegation

Status: experimental implementation in the unreleased source. Disabled by default.
The package remains `specpi`; no separate npm package or background service is required.

SpecPi keeps one agent responsible for changes and acceptance. This extension adds
bounded, read-only workers for independent questions. It does not add a second writer,
an automatic planner, or a permanent team. The [research](research.md) supports testing
selective delegation; it does not establish that this implementation improves outcomes.

## Start the supported host

```sh
specpi agent --help
specpi agent
```

The experimental launcher supports **Pi SDK 0.84.4 exactly**. The ordinary SpecPi
installer still supports Pi 0.84.4 or later. A standalone Pi binary or a newer SDK is
not proof of delegation compatibility; the launcher rejects unsupported versions.
If the SDK is not resolvable alongside the installed SpecPi package, select its
absolute package directory explicitly:

```sh
specpi agent --pi-sdk /absolute/path/to/node_modules/@earendil-works/pi-coding-agent
```

No SDK is downloaded by this command. From an audited source checkout, use
`node scripts/specpi.mjs agent` with the same options. Installing Pi and SpecPi remains
a separate, human-controlled action.

This is a small SDK host, not a replacement implementation of every native `pi` CLI
option. It runs Pi's interactive UI and parent session/provider pipeline. The SDK
owns authentication, provider configuration and ordinary parent session storage.
SpecPi does not extract credentials or create child session files.

The launcher loads the bundled SpecPi protections and supported already-installed
global resources. Project settings, extensions, skills, prompts, themes and context
files are disabled by default. This also suppresses global AGENTS context discovery.
Use **`--trust-project` only for a project whose executable resources and instructions
you intend to load**. That flag applies to this launch, not a persisted trust decision.
Trust restrictions are reapplied on resource reload and session replacement.
Configured or environment HTTP proxy policies that this public SDK bootstrap cannot
preserve are rejected. No silent proxy bypass is supported.

Stock `pi` does not auto-load the delegation runtime. Pi's normal extension API does
not expose the owner session's complete request pipeline. The explicit launcher
provides that capability through a closure while retaining the public SDK boundary.

## Enable deliberately

In the interactive session:

```text
/delegate on
/delegate status
/delegate limits
/delegate cancel <batchId>
/delegate off
```

`on` grants the displayed experimental calls/time envelope. There is no model-call
permission toggle in the model-facing tool. `limits` is read-only; the shipped ceilings
cannot be raised by prompts. Turning delegation off, changing guard policy, switching
sessions or models, navigating branches, and changing task/scope bindings revoke the
current generation. Off/on and runtime replacement do not reset the launcher's counters
or free requests that are still settling. Normal conversation leaf advancement does
not invalidate workers.

Command Guard continues to intercept the parent `delegate` tool. Strict mode presents
the effective capability envelope and binds approval to its policy fingerprint and
the exact call. Guard Off and Locked modes cannot activate delegation. A worker result
cannot authorize a write, a commit, a deployment, or an improvement.

## Choose a bounded question

| Mode | Input and tools | Suitable question |
| --- | --- | --- |
| `review` | Supplied inline context; no tools | Which defects or uncovered requirements exist in this frozen design? |
| `consult` | Supplied inline context; no tools | Which assumption distinguishes two plausible explanations? |
| `investigate` | Exact selected repository text files; list/read/literal-search only | Where does this behavior originate, with source references? |
| `research` | Exact selected text source material; same snapshot tools | Where do these supplied sources disagree, and what are their limits? |

All four use the **exact parent model**, including its configured provider route and
thinking policy. The current research profile has **no live web access**. The parent
must obtain and select the material. Model routing, automatic retries, a public-web
adapter, monetary admission, and automatic policy tuning remain future work.

The parent sends a small packet with fixed requirement IDs, relevant decisions,
non-goals, the worker question, selected context, and the reason delegation is useful.
It states who consumes the result and what independent work the parent will do.
Those statements guide the model; the scheduler cannot prove semantic independence.
`/task` remains optional. Changes to an active task contract invalidate delegation,
but the parent is still responsible for faithfully transferring the task into the packet.

Use `delegate run`, continue useful parent work, then `collect`. Collection can wait
up to 30 seconds without another model request. Do not poll on a fixed schedule.
Check the referenced evidence and `resolve` each report, including per-finding
dispositions. One changed-input `follow_up` is available under the original deadline
and counters. [Protocol and executable examples](protocol.md) define the exact fields.

## Enforced resource envelope

| Resource | Ceiling |
| --- | --- |
| Active worker requests | 2 across the launcher, including cancelled requests still settling |
| Batches / jobs | 4 batches per launcher; one unresolved batch; 4 jobs per batch |
| Model invocations | 48 per launcher, 12 per batch; 2 per review/consult job, 4 per investigate/research job |
| Follow-ups / configurable retries | 1 changed-input follow-up per job; automatic retries disabled |
| Time | 120 seconds per logical job; 300 seconds per batch, including follow-up time |
| Packet / child context | 256 KiB before request; rechecked after supported context transformations |
| Selected sources | 200 files and 8 MiB per batch |
| Tools | 12 calls and 64 KiB total returned JSON per logical job |
| Tool response | Bounded reads/search; 16 KiB per snapshot read/search response |
| Final report | 16 KiB; 8 findings; coverage for each requirement |
| Requested provider output | 2,048 tokens, subject to the adapter's token semantics |
| Retained parsed response | 256 KiB observed-message bound, with abort on oversize |

These are **model-invocation and retained-output limits**, not a hard invoice,
raw-network, provider-attempt or process-memory cap. Pi adapters may buffer before
events arrive, and transport fallback may add upstream attempts outside configurable
retries. A single oversized event can already have been allocated before it is rejected.
Cost is reported as unavailable; incomplete usage is never represented as zero usage.
This version cannot satisfy a policy requiring those unsupported hard guarantees.

Cancellation revokes broker access immediately and aborts the request. The job may
be terminal while its provider is still settling. Its concurrency slot remains occupied
until settlement; late content is discarded. A permanently non-cooperative provider
can require ending the launcher. No timeout starts a replacement behind its back.

## Evidence and retention

Snapshots contain only exact selected regular text files under the launch root. The
broker rejects traversal, symlinks/junctions, hardlinks, binary content, private path
names, unknown source IDs, and oversized reads. Each worker can search only its own
selection. The broker rechecks identity and content when capturing, accessing and
consuming evidence. Changed source bindings require a fresh batch.

This is a trusted-local-filesystem contract, not an operating-system sandbox or an
atomic filesystem snapshot. Filename restrictions cannot detect secrets embedded in
an ordinary source file. The parent must select appropriate material for the configured
model provider. Trusted Pi extensions remain privileged and can transform provider
requests; only the submitted packet is inherited automatically, not the parent transcript.

Each report separates worker claims from a host receipt: job/attempt identity, packet
digest, generation, result revision, route, state, counters and usage completeness.
Source references are validated for identity and line range; their truth is still a
verification question for the parent. `accept` records a parent assessment, not human
approval or verified task completion.

Worker conversations, snapshots and the bounded idempotency journal are held in
memory for the launcher lifetime. There is no child session database, raw metrics log,
credential copy, automatic resume, or secure memory-erasure claim. Normal Pi parent
tool results may be retained in its ordinary session. Turning delegation off does not
remove results already retained by Pi; review the session before sharing it.

## Implementation and evaluation

The runtime is six small modules under `extensions/delegation/`: protocol validation,
controller, snapshot broker, worker loop, provider bridge, and extension registration.
`scripts/agent.mjs` supplies the SDK host. There are no additional runtime dependencies.

Tests exercise controller quotas and races, source isolation, lifecycle invalidation,
closed result validation, the public Pi provider pipeline, guard interception, project
discovery restrictions, reloads and packaged installation. They use isolated state and
synthetic providers. They do not spend tokens on a user's account or establish parity
with every production provider.

The [evaluation plan](evaluation.md) compares selective delegation with strong single
agents, serial workflows and always-delegate baselines using matched resource budgets.
No production quality, speed or cost improvement is claimed until those experiments run.
The [original design](design.md) and [target protocol](design-protocol.md) preserve the
broader proposal and its currently unimplemented proof obligations. The implemented
[calls/time protocol](protocol.md) is the source of truth for this release's behavior.

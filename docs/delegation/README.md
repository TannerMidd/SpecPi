# Bounded delegation

Status: experimental implementation in the unreleased source. Disabled by default.
The package remains `specpi`; no separate npm package or background service is required.

SpecPi keeps one agent responsible for changes and acceptance. This extension adds
bounded, read-only workers for independent questions. It does not add a second writer,
an automatic planner, or a permanent team. The [research](research.md) supports testing
selective delegation; it does not establish that this implementation improves outcomes.

## Use normal Pi startup

```sh
pi
```

The native extension is discovered through the ordinary Pi package and SpecPi
install/update lifecycle. Existing Pi startup, UI, resources, trust decisions and
proxy configuration remain Pi-owned. Delegation needs no alternate launcher, extra
SDK host, separate runtime process or new setup path.

Pi 0.84.4 is the reviewed compatibility-test floor, not an exact-version gate or a
promise that all later versions are compatible. The extension checks for the public
`ctx.modelRegistry.complete` capability and fails closed when it is absent. Restart
Pi to load a new delegation runtime version or to change its working root. The broker
is bound to the canonical working directory captured for this Pi process.

The bridge calls `ctx.modelRegistry.complete(ctx.model, context, options)` with explicit
bounded text context and validated options. Pi owns authentication, OAuth refresh and
the model registry's configured provider route; SpecPi does not extract credentials.
This public completion API is **not the parent's full inference pipeline**. Workers
do not inherit parent context/header/payload/response hooks, transport or thinking
settings, or session affinity. Reasoning uses provider defaults. A workflow requiring
those parent hooks or settings for every request must keep delegation disabled.

Receipts bind the selected model/provider IDs, not a frozen provider configuration.
The registry may change its endpoint, headers or authentication configuration without
changing those public identities. Delegation cannot detect every such change.

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
current generation. Off/on, `/reload` and session switches do not reset the Pi process's
counters or free requests that are still settling. The same in-memory controller remains
in use; restart Pi to load changed runtime code. Normal conversation leaf advancement
does not invalidate workers.

While delegation is off, its tool is removed from the parent's active tool list.
The command remains available, but the delegation tool schema is included in model
requests only after activation. Other active tools are preserved.

Command Guard continues to intercept the parent `delegate` tool. Strict mode presents
the effective capability envelope and binds approval to its policy fingerprint and
the exact call. Guard Off and Locked modes cannot activate delegation. A worker result
cannot authorize a write, a commit, a deployment, or an improvement.

## Choose a bounded question

| Mode          | Input and tools                                                     | Suitable question                                                    |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `review`      | Supplied inline context; no tools                                   | Which defects or uncovered requirements exist in this frozen design? |
| `consult`     | Supplied inline context; no tools                                   | Which assumption distinguishes two plausible explanations?           |
| `investigate` | Exact selected repository text files; list/read/literal-search only | Where does this behavior originate, with source references?          |
| `research`    | Exact selected text source material; same snapshot tools            | Where do these supplied sources disagree, and what are their limits? |

All four use the **exact parent model** through Pi's public model registry, with
provider-default reasoning rather than the parent's thinking settings. The current
research profile has **no live web access**. The parent
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

| Resource                          | Ceiling                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Active worker requests            | 2 per Pi process, including cancelled requests still settling                             |
| Batches / jobs                    | 4 batches per Pi process; one unresolved batch; 4 jobs per batch                          |
| Model invocations                 | 48 per Pi process, 12 per batch; 2 per review/consult job, 4 per investigate/research job |
| Follow-ups / configurable retries | 1 changed-input follow-up per job; automatic retries disabled                             |
| Time                              | 120 seconds per logical job; 300 seconds per batch, including follow-up time              |
| Packet / child context            | 256 KiB, checked before dispatch                                                          |
| Selected sources                  | 200 files and 8 MiB per batch                                                             |
| Tools                             | 12 calls and 64 KiB total returned JSON per logical job                                   |
| Tool response                     | Bounded reads/search; 16 KiB per snapshot read/search response                            |
| Final report                      | 16 KiB; 8 findings; coverage for each requirement                                         |
| Requested provider output         | 2,048 tokens, subject to the adapter's token semantics                                    |
| Completed response                | 256 KiB acceptance limit, checked after the completion Promise resolves                   |

These are **model-invocation, deadline and post-completion acceptance limits**, not
midstream, raw-network, provider-attempt, invoice or process-memory caps. The public
API returns a complete-message Promise: SpecPi cannot inspect or bound streamed output
while inference runs. An oversized response may already be fully buffered before
SpecPi rejects it. Provider fallback may add upstream attempts outside configurable
retries.
Cost is reported as unavailable; incomplete usage is never represented as zero usage.
This version cannot satisfy a policy requiring those unsupported hard guarantees.

Cancellation revokes broker access immediately and requests provider abort. The job may
be terminal while its provider is still settling. Its concurrency slot remains occupied
until settlement; late content is discarded. A permanently non-cooperative provider
can require ending the Pi process. No timeout starts a replacement behind its back.

## Evidence and retention

Snapshots contain only exact selected regular text files under the fixed canonical
working root of the Pi process. The
broker rejects traversal, symlinks/junctions, hardlinks, binary content, private path
names, unknown source IDs, and oversized reads. Each worker can search only its own
selection. The broker rechecks identity and content when capturing, accessing and
consuming evidence. Changed source bindings require a fresh batch.

This is a trusted-local-filesystem contract, not an operating-system sandbox or an
atomic filesystem snapshot. Filename restrictions cannot detect secrets embedded in
an ordinary source file. The parent must select appropriate material for the configured
model provider. Trusted Pi extensions remain privileged, but the parent's per-request
hooks are not inherited by this completion bridge. Only the submitted packet is
inherited automatically, not the parent transcript.

Each report separates worker claims from a host receipt: job/attempt identity, packet
digest, generation, result revision, route, state, counters and usage completeness.
Source references are validated for identity and line range; their truth is still a
verification question for the parent. `accept` records a parent assessment, not human
approval or verified task completion.

Worker conversations, snapshots and the bounded idempotency journal are held in
memory for the Pi process lifetime, including across `/reload` and session switches.
There is no child session database, raw metrics log,
credential copy, automatic resume, or secure memory-erasure claim. Normal Pi parent
tool results may be retained in its ordinary session. Turning delegation off does not
remove results already retained by Pi; review the session before sharing it.

## Implementation and evaluation

The native extension and modules under `extensions/delegation/` provide protocol
validation, controller, snapshot broker, worker loop and public completion bridge.
There are no additional runtime dependencies or separate host process.

Tests exercise controller quotas and races, source isolation, lifecycle invalidation,
closed result validation, the public completion capability, guard interception,
process-wide accounting across reloads, fixed-root binding and packaged installation.
They use isolated state and
synthetic providers. They do not spend tokens on a user's account or establish parity
with the parent's full inference pipeline or every production provider.

The [evaluation plan](evaluation.md) compares selective delegation with strong single
agents, serial workflows and always-delegate baselines using matched resource budgets.
No production quality, speed or cost improvement is claimed until those experiments run.
The [original design](design.md) and [target protocol](design-protocol.md) preserve the
broader proposal and its currently unimplemented proof obligations. The implemented
[calls/time protocol](protocol.md) is the source of truth for this release's behavior.

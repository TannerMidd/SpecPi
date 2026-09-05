# Delegation protocol: bounded-pi-sessions-v1

This is the implemented in-process API. It has no HTTP listener, daemon, child process,
or child session store. The broader [target protocol](design-protocol.md) remains a
proposal; its stronger transport/attempt/cost gates are not supplied by this version.

The extension loads through normal `pi` package discovery and remains disabled until
the human runs `/delegate on`. The SDK version allowlist is **Pi 0.84.4 and 0.85.0**;
other versions fail the delegation support gate pending compatibility review. Allowlist
membership does not itself establish a passing provider or native integration suite.
Workers are SDK `createAgentSession` instances using in-memory session storage and a
fresh Pi `ModelRuntime`. The parent model and thinking level are passed explicitly,
subject to Pi's clamping. Standard Pi authentication, environment and `models.json`
resolution apply. Child transport/thinking budgets come from configured global settings;
project settings are not loaded. Runtime-only authentication, selected extension-provider
overrides, model-specific headers, startup proxy configuration and safe model-descriptor
mismatches fail preflight. Parent request hooks,
ephemeral runtime settings, session affinity and ambient resources are not inherited.

The SDK runs the conversation and selected-source tool loop. SpecPi admits each SDK
invocation before dispatch and observes the SDK stream; provider/session retries and
automatic compaction are disabled. This does not establish hard raw-transport,
hidden-provider-attempt, invoice or process-memory limits.
Pi authentication preflight precedes the model-invocation counter; its preparation
is not a model invocation or an operation bounded by that counter.

Every object is closed: unknown fields, duplicate IDs, malformed values and oversized
data are rejected. The host creates identities and receipts; workers cannot supply them.
The protocol identifier `bounded-pi-sessions-v1` and inference contract
`pi-agent-session-v1` describe the host implementation, not model-selected options.

## Submit a batch

After the human runs `/delegate on`, the parent calls the `delegate` tool:

```json
{
    "operation": "run",
    "requestId": "scout-routing-1",
    "packet": {
        "objective": "Explain how model selection reaches the request pipeline",
        "requirements": [{ "id": "R1", "text": "Identify the route binding and its invalidation behavior" }],
        "decisions": ["The parent remains the sole writer"],
        "nonGoals": ["Do not implement or change providers"],
        "reason": {
            "benefit": "parallel_analysis",
            "why": "Source analysis can proceed independently of the parent's lifecycle-test inspection",
            "parentWork": "Inspect the lifecycle tests while the worker reads"
        },
        "jobs": [
            {
                "id": "route",
                "mode": "scout",
                "requirements": ["R1"],
                "question": "Where is the model captured, and when is that capability revoked?",
                "context": "Return evidence for R1, including missing or contrary evidence.",
                "sources": ["extensions/delegation/provider.mjs"]
            }
        ]
    }
}
```

`run` returns immediately with `batchId`, `packetDigest`, `generation`, a collection
cursor and job states. It does not return invented findings while work is pending.
The digest binds the packet, source descriptors, host identity, selected model/provider
IDs and resource policy. It does not freeze the registry's endpoint, headers or
authentication configuration. Those can change behind the same public identities;
the extension cannot observe every such change or certify an unchanged provider route.
IDs are short alphanumeric/hyphen/underscore strings. The host batch and attempt IDs
are UUIDs. Source paths are exact relative filenames, not directories, globs or commands.
Modes are `review` and `scout`. Either can use the selected-source list/read/literal-search
tools when files are supplied. A scout requires at least one selected file. A review
requires nonempty inline context or selected files; with an empty `sources` array it
uses inline context without tools. Source selection never grants ambient filesystem
or web access. Questions that are identical after trimming and case normalization are
rejected; distinct text does not establish distinct reasoning work.

`reason` contains exactly `benefit`, `why` and `parentWork`. `why` is nonempty.
`independent_review` requires review jobs; `parallel_analysis` and `context_isolation`
require scout jobs. `parentWork` must describe useful concurrent work for
`parallel_analysis` and may be empty otherwise. These are structural admission checks,
not proof that delegation improves the task.

Each job's nonempty `requirements` list names unique IDs from the packet's global
requirements. The child receives only its assigned requirements, plus the global
decisions and non-goals. A batch contains at most two jobs. All modes require the same
explicit packet fields, even when an allowed array or string is empty.

## Inspect and collect

```json
{ "operation": "status" }
```

```json
{ "operation": "collect", "batchId": "HOST_BATCH_ID", "afterCursor": 0, "waitMs": 30000 }
```

`status` is compact and available while disabled. `collect` returns reports whose
completion cursor is newer than `afterCursor`; omitting it replays retained reports.
`waitMs` defaults to zero and cannot exceed 30 seconds. There is no destructive dequeue
and no automatic parent turn. A cursor ahead of the batch is invalid.

Collection rechecks host/task/policy generation and every selected source binding.
A changed file is stale even when its pathname is unchanged. Source or lifecycle changes
cannot be repaired by presenting an old receipt or idempotency key.

Each returned item has `receipt`, `result`, `error`, and `disposition`. A host receipt
contains `batchId`, `jobId`, `attemptId`, `packetDigest`, `generation`, `resultRevision`,
`model`, `state`, `settling`, call/tool counters, token usage, `usageComplete`, and
`cost: null`. Copy the six binding fields when following up or resolving. The
`collectionCursor` belongs to delivery ordering, not result identity.

## Worker report

Workers return this exact shape, without Markdown fences:

```json
{
    "status": "partial",
    "answer": "The selected context is insufficient to establish runtime behavior.",
    "requirements": [{ "id": "R1", "status": "unaddressed", "evidence": [] }],
    "findings": [],
    "missing": ["A provider implementation or runtime fixture"],
    "nextStep": "The parent should inspect the provider fixture before making a claim."
}
```

Statuses are `complete`, `partial`, or `needs_context`. Every assigned requirement appears
exactly once as `addressed` or `unaddressed`. Each finding has `id`, `claim`, `confidence`
(`observed`, `inferred`, `unverified`), `evidence` and `contraryEvidence`. Evidence entries
contain exactly `sourceId`, `lineStart`, `lineEnd`. References must resolve within the
job selection and valid line ranges. `p1` denotes the submitted inline context; it
does not denote the parent transcript or prove repository behavior. `observed` requires
at least one reference. At most eight findings and 16 KiB are retained.

Malformed reports fail the attempt. There is no automatic retry. Provider exceptions
are reduced to a generic failure message because raw errors may contain sensitive URLs
or content. Missing usage is explicit; failed calls still consume invocation allowance.

## Follow up and resolve

```json
{
    "operation": "follow_up",
    "requestId": "route-correction-1",
    "batchId": "HOST_BATCH_ID",
    "jobId": "route",
    "attemptId": "HOST_ATTEMPT_ID",
    "packetDigest": "HOST_64_CHARACTER_SHA256",
    "generation": 2,
    "resultRevision": 1,
    "prompt": "Reconsider the claim using the already-selected source; identify the missing condition."
}
```

The uppercase placeholders above must be replaced with the current host receipt.
One follow-up creates a new attempt under the original job deadline, context,
selected sources, model-call counters and tool counters. It cannot add files, change
models, extend time or reset quotas. If it needs a new grant or source set, discard
the report and submit a fresh batch. A settling, cancelled, expired, stale or finally
disposed result cannot receive a follow-up.

```json
{
    "operation": "resolve",
    "requestId": "route-assessment-1",
    "batchId": "HOST_BATCH_ID",
    "jobId": "route",
    "attemptId": "HOST_ATTEMPT_ID",
    "packetDigest": "HOST_64_CHARACTER_SHA256",
    "generation": 2,
    "resultRevision": 1,
    "decision": "needs_check",
    "findings": []
}
```

Overall decisions are `accept`, `discard`, `needs_check`. Each returned finding must
appear exactly once in `findings` with `{ "id": "F1", "decision": "confirmed" }`,
`rejected`, or `needs_check`. Acceptance requires a result and no unchecked findings.
Accept/discard finalize the parent disposition; needs_check leaves it open for a later
assessment or allowed follow-up. These are parent assertions, never human permission,
automatic tool execution, verified completion, or wishlist authorization.

All mutations require `requestId`. Replaying the identical request returns its stored
response without another request or transition. Reusing an ID with a different payload
fails. The bounded journal retains failures too. Generation and source checks still
apply when replaying successful operations. No idempotency record resets accounting.

## Cancellation and lifecycle

```json
{ "operation": "cancel", "requestId": "cancel-route-1", "batchId": "HOST_BATCH_ID", "jobId": "route" }
```

Omit `jobId` to cancel the batch. Cancellation remains available after invalidation.
Job states are `queued`, `running`, the three report statuses, `failed`, `cancelled`,
`expired`, and `stale`. Terminal job state and `settling` are separate. Cancellation
revokes tool access and requests SDK abort. A worker keeps its global slot through
SDK-visible stream/result and prompt settlement. Old payloads are discarded. Neither
terminal receipt delivery nor SDK settlement proves physical remote execution has ended.

The same in-memory controller survives `/reload` and session switches within the Pi
process. Its ceilings are two active workers, four batches and 32 SDK model invocations
per process, with two jobs and 8 invocations per batch and four invocations per logical
job including one follow-up. Requested output is 8,192 tokens clamped to the model
maximum. These are experiment limits, not research-derived optimal values.
Human off/on, task changes,
branch navigation, model selection, guard changes and reloads revoke old generations;
they do not create a new resource allowance. Normal parent turns do not revoke a job.
The canonical working root remains fixed for that process. Restart Pi to change the
root or load a new delegation runtime version. There is no retry on process restart
and no durable worker queue. Completed reports retain their original source bindings
after the deadline; child sessions are released at the deadline and subsequent
follow-up is rejected. SDK-visible response checks can reject oversized observed
content during the stream, but bytes can already be buffered before an SDK event.

The enforced [resource envelope and limitations](README.md#enforced-resource-envelope)
define `bounded-pi-sessions-v1`. Unsupported hard billing, raw transport, provider
attempt and process-memory policies are not accepted through this API.

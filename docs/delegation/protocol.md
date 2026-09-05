# Delegation protocol: experimental-calls-time-v1

This is the implemented in-process API. It has no HTTP listener, daemon, child process,
or child session store. The broader [target protocol](design-protocol.md) remains a
proposal; its stronger transport/attempt/cost gates are not supplied by this version.

The extension loads through normal `pi` package discovery and remains disabled until
the human runs `/delegate on`. Pi 0.84.4 is the compatibility-test floor; runtime
admission checks the public `modelRegistry.complete` capability. This native bridge
uses the parent model through Pi-owned authentication and provider routing, but does
not inherit parent request hooks, transport/thinking settings or session affinity.
It uses provider-default reasoning. Inputs are bounded before dispatch; complete
responses can only be checked after the returned Promise resolves.

Every object is closed: unknown fields, duplicate IDs, malformed values and oversized
data are rejected. The host creates identities and receipts; workers cannot supply them.
The protocol identifier is returned by `status`. It is not a model-selected option.

## Submit a batch

After the human runs `/delegate on`, the parent calls the `delegate` tool:

```json
{
    "operation": "run",
    "requestId": "investigate-routing-1",
    "packet": {
        "objective": "Explain how model selection reaches the request pipeline",
        "requirements": [{ "id": "R1", "text": "Identify the route binding and its invalidation behavior" }],
        "decisions": ["The parent remains the sole writer"],
        "nonGoals": ["Do not implement or change providers"],
        "reason": {
            "deliverable": "A source-backed explanation of route binding",
            "consumer": "The parent will compare it with the lifecycle tests",
            "independence": "Reading this module is independent of inspecting test coverage",
            "parentWork": "Inspect the lifecycle tests while the worker reads"
        },
        "jobs": [
            {
                "id": "route",
                "mode": "investigate",
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
`review` and `consult` require an empty `sources` array; their only evidence is inline
context. All modes require the same explicit packet fields, even when an array is empty.

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

Statuses are `complete`, `partial`, or `needs_context`. Every requirement appears
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
revokes tool access and requests provider abort; a request keeps its global slot until
the provider settles. Old payloads are discarded. Terminal receipt delivery does not
imply that network activity has already ended.

The same in-memory controller survives `/reload` and session switches within the Pi
process. Its ceilings are two active requests, four batches and 48 model invocations
per process. Human off/on, task changes,
branch navigation, model selection, guard changes and reloads revoke old generations;
they do not create a new resource allowance. Normal parent turns do not revoke a job.
The canonical working root remains fixed for that process. Restart Pi to change the
root or load a new delegation runtime version. There is no retry on process restart
and no durable worker queue. These limits do not bound midstream output or allocation;
an oversized complete response is rejected only after it has been returned.

The enforced [resource envelope and limitations](README.md#enforced-resource-envelope)
define `experimental-calls-time-v1`. Unsupported hard billing, raw transport, provider
attempt and process-memory policies are not accepted through this API.

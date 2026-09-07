# Bounded delegation

Experimental; enabled by default at normal `pi` startup. No measured quality, speed or cost benefit is claimed.

The parent remains the sole writer and verifies workers' evidence. Use delegation for a substantial independent question or frozen review, not routine lookups, small edits, coupled work or generic second opinions. Workers are real Pi SDK sessions with in-memory storage, selected-source read/search tools, no shell, writes, live web, ambient extensions or parent history.

## Controls

```text
/delegate status
/delegate limits
/delegate cancel <batchId>
/delegate off
/delegate on
```

Startup enables dispatch only after host, settings and Guard checks; it launches no workers. Preflight may perform Pi-owned authentication/OAuth preparation. Off and safety revocations survive reload/session switches; restarting Pi restores the on default. While off, the tool is absent from model requests.

The TUI panel shows worker state, elapsed time and call counts. **Ready for review** requires a parent disposition; **stopping** still occupies a slot. RPC mode additionally publishes bounded, versioned worker metadata for SpecPi Chat's live Delegates panel; print/JSON modes do not mount widgets. Chat shows expandable tasks/metrics, attempt-bound Stop controls, and advisory transcript summaries. Update both Chat and the harness, then restart Pi. Expand tool output for findings and evidence.

Model/thinking changes revoke old results and preflight the new route. Unsupported routes pause dispatch; compatible selections resume it unless explicitly off. Guard, session, branch and task/scope changes revoke the current generation. Ordinary conversation advancement does not. Reload/off/on never reset spent process quotas or release unsettled requests. Restart Pi to load changed runtime code or a different working root.

Command Guard is optional. Active Strict Guard binds approval to the exact call and effective policy; locked, unready or ambiguous installed Guard blocks activation. Workers remain restricted independently of Guard. Neither worker output nor parent acceptance grants human approval.

## Persistent limits

Change settings only while delegation is off:

```text
/delegate off
/delegate timeout 15
/delegate budget 16
/delegate on
```

- `timeout`: whole minutes 1–60, default 10; `timeout reset` restores it. Batch deadline is twice the job timeout. Both begin at admission, including queue/follow-up time.
- `budget`: multiplier 1–64, default 8; `budget reset` restores it. Scales call/byte/context allowances, not concurrency, deadlines or per-response limits. Higher budgets can increase cost.
- Commands without values show current settings. Models cannot change them. Changes preserve consumed process counters and cannot extend existing jobs.

Preferences live in `<agent-dir>/specpi/delegation/settings.json`, with an atomic backup and checksum; `<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. They survive uninstall. Linked, malformed, oversized or unreadable preferences block activation. Repair manually and restart; external edits are loaded on restart, not reload. Pi credentials/settings/history are not modified.

Default envelope (`/delegate limits` reports the effective policy):

| Resource | Ceiling |
| --- | --- |
| Concurrent requests | 2, including cancelled requests still settling |
| Batches | 32/process; one unresolved batch; 2 jobs/batch |
| SDK model calls | 256/process, 64/batch, 32/job including follow-up |
| Follow-up | One changed-input attempt, original budgets/deadline |
| Handoff / child context | 256 KiB / 2 MiB |
| Selected sources | 200 files, 8 MiB/batch |
| Source tools | 96 calls, 512 KiB returned JSON/job; 16 KiB/read or search |
| Final report | 16 KiB, 8 findings, coverage of every assigned requirement |
| SDK-visible response | 1 MiB acceptance limit |

Provider/session retries and compaction are disabled. Correctable source arguments and malformed reports can consume further calls within the same job. A failed attempt is not a review. Exhaustion, revocation and source changes terminate it. These are SDK-visible limits, not guarantees about raw transport, memory, remote attempts or billing. Cost is unavailable; missing token fields are `null` and receipts identify partial usage.

## Workflow and evidence

1. `run`: supply requirements, decisions, non-goals and distinct jobs. `review` needs frozen inline context or files; `scout` needs selected files. Explain the independent-review, parallel-analysis or context-isolation benefit; parallel work also names useful parent work.
2. `collect`: wait up to 30 seconds for advisory reports; avoid fixed polling.
3. Verify source citations and findings against the original requirements.
4. `resolve`: record acceptance/discard/check-needed and each finding's disposition. One changed-input `follow_up` shares the original budget and deadline.

See [protocol.md](protocol.md) for exact request and receipt fields.

Only exact regular text files under the startup working root are selectable. Traversal, links/hardlinks, binary/oversized files, private runtime storage and credential stores are rejected. Ordinary authentication/session *source code* names are allowed. Filenames cannot prove absence of secrets: the parent must select material appropriate for the provider. Workers see only their own selected snapshot. Paths/identity/change metadata are checked during tools; content digests are rechecked at publication, collection, follow-up and resolution. Changed bindings require a fresh batch.

Selection errors identify a safe reason and source position, without raw paths/errors; no worker starts or inference allowance is spent. Fix the cause, never rename or copy restricted material to evade policy. Source references are checked for identity/range, not truth. Parent acceptance is not independent proof or task completion.

Cancellation revokes access and requests SDK abort. Slots remain held until SDK-visible settlement; this cannot prove remote execution ended. Late content is discarded. Non-cooperative providers may require ending Pi. Sessions are released on final disposition, cancellation, exhausted follow-up or deadline; settled text/packets are dropped when no job can continue. Completed reports retain source bindings; a new accepted batch retires previous reports. Only bounded summaries, counters and idempotency records remain for the process lifetime. No child database, raw metrics log, automatic resume or secure-erasure guarantee exists. Parent tool results may remain in Pi history even after delegation is off.

## Host limitations

Activation checks required public SDK capabilities, not an exact version allowlist. The installer retains its separate Pi 0.84.4 bootstrap pin. Restart after updating the runtime.

Children use fresh Pi `ModelRuntime` instances with standard authentication/environment/models resolution and global transport/thinking settings. Project settings are not loaded. Parent model/thinking are explicit and checked through Pi's public APIs. Runtime-only authentication, selected extension-provider overrides, model headers, startup proxy configuration and mismatched model descriptors are rejected rather than silently approximated.

Parent hooks, ephemeral settings and session affinity are **not inherited**. Keep delegation off if they are required on every request. Stable provider identity cannot certify an unchanged remote service. Trusted extensions still share Pi's privileged process; this is a trusted-local-filesystem contract, not an OS sandbox. See [SECURITY_MODEL.md](../../SECURITY_MODEL.md) for the authoritative boundaries and [THIRD_PARTY.md](../../THIRD_PARTY.md) for dependency compatibility.

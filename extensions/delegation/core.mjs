import { randomUUID } from "node:crypto";
import { createSnapshot } from "./snapshot.mjs";
import { LIMITS, digest, validateOperation } from "./protocol.mjs";
import { runWorker } from "./worker.mjs";
import { DelegationError, publicErrorMessage } from "./errors.mjs";

const terminal = new Set(["complete", "partial", "needs_context", "failed", "cancelled", "expired", "stale"]);
const quiet = new Set(["cancelled", "expired", "stale"]);

/** One controller lives for the Pi process, including native extension reloads. */
export function createDelegationController({
    getHost,
    root,
    onChange = () => {},
    limits = LIMITS,
    snapshotFactory = createSnapshot,
    worker = runWorker,
    getGuard = () => "absent",
}) {
    const policy = Object.freeze(
        Object.fromEntries(
            Object.entries(LIMITS).map(([key, maximum]) => {
                const value = limits[key] ?? maximum;
                if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
                    throw new DelegationError("Limits may only lower the fixed delegation ceilings");
                }

                return [key, value];
            }),
        ),
    );
    let enabled = false;
    let generation = 0;
    let enabledHost;
    let enabledGuard;
    let active = 0;
    let totalCalls = 0;
    let totalBatches = 0;
    let currentBatch;
    const batches = new Map();
    const history = new Map();
    const requests = new Map();
    const listeners = new Set();
    const changed = () => {
        for (const notify of listeners) {
            notify();
        }

        try {
            onChange();
        } catch {
            // An optional UI notification never changes resource ownership.
        }
    };

    const summary = (batch) => ({
        batchId: batch.id,
        generation: batch.generation,
        packetDigest: batch.packetDigest,
        collectionCursor: batch.cursor,
        calls: batch.calls,
        jobs: [...batch.jobs.values()].map((job) => ({
            jobId: job.spec.id,
            state: job.state,
            settling: job.settling,
            calls: job.calls,
            resultRevision: job.revision,
            disposition: job.disposition?.decision ?? null,
        })),
    });
    const status = () => ({
        enabled,
        policy: "bounded-pi-sessions-v1",
        generation,
        active,
        limits: policy,
        sessionCalls: totalCalls,
        sessionBatches: totalBatches,
        guard: getGuard() ?? "unavailable",
        model: enabledHost?.model ?? null,
        cost: "unavailable; no invoice cap",
        batches: [...[...history.values()].map((item) => structuredClone(item)), ...[...batches.values()].map(summary)],
    });
    const finish = (batch, job, state, result, error) => {
        if (terminal.has(job.state)) {
            return;
        }

        job.state = state;
        job.result = result;
        job.error = error;
        job.revision += 1;
        job.cursor = ++batch.cursor;
        changed();
    };

    const releaseJob = (job) => {
        const release = job.release;
        job.release = undefined;
        job.child = undefined;
        try {
            // Cleanup is best effort, including an unexpected async SDK teardown.
            // This never releases the slot: original worker settlement owns that.
            void Promise.resolve(release?.()).catch(() => {});
        } catch {
            // Do not expose or retain SDK teardown errors.
        }
    };

    const needsInput = (batch, job) =>
        !batch.retired &&
        !quiet.has(job.state) &&
        !job.disposition &&
        Date.now() < Math.min(job.deadline, batch.deadline) &&
        (!terminal.has(job.state) || job.followUps < 1);

    const cleanupBatch = (batch) => {
        if (batch.archived) {
            return;
        }

        for (const job of batch.jobs.values()) {
            if (!needsInput(batch, job)) {
                if (!terminal.has(job.state)) {
                    const state = batch.retired ? "stale" : "expired";
                    finish(batch, job, state, undefined, state);
                    job.controller?.abort();
                }

                clearTimeout(job.timer);
                releaseJob(job);
                if (!job.settling) {
                    job.spec = { id: job.spec.id };
                    job.followUpPrompt = undefined;
                    job.controller = undefined;
                }
            }
        }

        if ([...batch.jobs.values()].some((job) => needsInput(batch, job))) {
            return;
        }

        if (!batch.inputClosed) {
            batch.inputClosed = true;
            batch.snapshot.destroy();
        }

        if ([...batch.jobs.values()].some((job) => job.settling)) {
            return;
        }

        batch.packet = undefined;
        batch.host = undefined;
        if (batch.retired) {
            batch.archived = true;
            history.set(batch.id, { ...summary(batch), retired: true });
            batches.delete(batch.id);
            batch.snapshot = undefined;
            for (const job of batch.jobs.values()) {
                job.result = undefined;
                job.disposition = undefined;
            }
        }
    };

    const cancelJob = (batch, job, state = "cancelled") => {
        if (!terminal.has(job.state)) {
            finish(batch, job, state, undefined, state);
        } else if (!quiet.has(job.state) && !job.disposition) {
            job.state = state;
            job.result = undefined;
            job.error = state;
            job.revision += 1;
            job.cursor = ++batch.cursor;
        }

        job.controller?.abort();
        releaseJob(job);
        cleanupBatch(batch);
        changed();
    };

    const invalidate = (reason = "context changed") => {
        enabled = false;
        generation += 1;
        for (const batch of batches.values()) {
            batch.retired = true;
            for (const job of batch.jobs.values()) {
                cancelJob(batch, job, "stale");
            }
        }

        enabledHost = undefined;
        currentBatch = undefined;
        changed();

        return { enabled: false, generation, reason };
    };

    const assertLive = (batch, streaming = false) => {
        const guard = getGuard();
        if (
            !enabled ||
            !enabledHost?.isCurrent(streaming) ||
            getHost()?.id !== enabledHost.id ||
            guard !== enabledGuard ||
            guard === "locked"
        ) {
            if (enabled) {
                invalidate("session, model, or guard changed");
            }

            throw new DelegationError("Delegation is disabled or its host lease is stale");
        }

        if (batch && batch.generation !== generation) {
            throw new DelegationError("Delegation result belongs to a stale generation");
        }
    };

    const checkSources = (batch) => {
        try {
            batch.snapshot.assertFresh();
        } catch {
            for (const job of batch.jobs.values()) {
                cancelJob(batch, job, "stale");
            }

            throw new DelegationError("Selected source bindings changed; create a fresh batch");
        }
    };

    const findBatch = (id) => {
        const batch = batches.get(id);
        if (!batch) {
            throw new DelegationError(
                history.has(id) ? "Delegation batch was retired; its generation is stale" : "Unknown delegation batch",
            );
        }

        return batch;
    };

    const binding = (batch, job) => ({
        batchId: batch.id,
        jobId: job.spec.id,
        attemptId: job.attemptId,
        packetDigest: batch.packetDigest,
        generation: batch.generation,
        resultRevision: job.revision,
    });
    const findBoundJob = (input) => {
        const batch = findBatch(input.batchId);
        assertLive(batch);
        checkSources(batch);
        const job = batch.jobs.get(input.jobId);
        if (
            !job ||
            !terminal.has(job.state) ||
            Object.entries(binding(batch, job)).some(([key, value]) => input[key] !== value)
        ) {
            throw new DelegationError("Delegation receipt is missing or stale");
        }

        return { batch, job };
    };

    const pump = () => {
        for (const batch of batches.values()) {
            for (const job of batch.jobs.values()) {
                if (active >= policy.concurrency || job.state !== "queued") {
                    continue;
                }

                if (Date.now() >= job.deadline || Date.now() >= batch.deadline) {
                    cancelJob(batch, job, "expired");
                    continue;
                }

                try {
                    assertLive(batch);
                    checkSources(batch);
                } catch {
                    cancelJob(batch, job, "stale");
                    continue;
                }

                job.state = "running";
                job.settling = true;
                job.controller = new AbortController();
                active += 1;
                const assertJobLive = (streaming = false) => {
                    assertLive(batch, streaming);
                    if (
                        terminal.has(job.state) ||
                        job.controller.signal.aborted ||
                        Date.now() >= job.deadline ||
                        Date.now() >= batch.deadline
                    ) {
                        throw new DelegationError("Worker lease expired or was revoked");
                    }
                };

                const execution = async () => {
                    try {
                        const result = await worker({
                            packet: batch.packet,
                            job,
                            host: batch.host,
                            snapshot: batch.snapshot,
                            signal: job.controller.signal,
                            abort: () => job.controller.abort(),
                            assertLive: assertJobLive,
                            limits: policy,
                            admitCall: () => {
                                assertJobLive();
                                if (
                                    job.calls >= policy.jobCalls ||
                                    batch.calls >= policy.batchCalls ||
                                    totalCalls >= policy.sessionCalls
                                ) {
                                    throw new DelegationError("Delegation model-call allowance exhausted");
                                }

                                job.calls += 1;
                                batch.calls += 1;
                                totalCalls += 1;
                            },
                            onUsage: (usage) => {
                                for (const key of Object.keys(job.usage)) {
                                    const number = usage?.[key];
                                    if (
                                        Number.isSafeInteger(number) &&
                                        number >= 0 &&
                                        Number.isSafeInteger(job.usage[key] + number)
                                    ) {
                                        job.usage[key] += number;
                                        job.usageReportedCalls[key] += 1;
                                    }
                                }
                            },
                        });
                        assertJobLive();
                        checkSources(batch);
                        finish(batch, job, result.status, result);
                    } catch {
                        // Provider errors can contain URLs, credentials, or user content. Do not return them.
                        finish(
                            batch,
                            job,
                            "failed",
                            undefined,
                            "Worker failed or exhausted a bound; inspect status and use one changed-input follow-up if appropriate.",
                        );
                    } finally {
                        job.controller.abort();
                        job.settling = false;
                        if (!job.result || quiet.has(job.state)) {
                            releaseJob(job);
                        }

                        active -= 1;
                        cleanupBatch(batch);
                        changed();
                        pump();
                    }
                };

                void execution();
            }
        }
    };

    const armDeadline = (batch, job) => {
        clearTimeout(job.timer);
        job.timer = setTimeout(
            () => {
                if (Date.now() < Math.min(job.deadline, batch.deadline)) {
                    armDeadline(batch, job);

                    return;
                }

                if (terminal.has(job.state) && !job.settling) {
                    releaseJob(job);
                } else {
                    cancelJob(batch, job, "expired");
                }

                cleanupBatch(batch);
                pump();
            },
            Math.max(1, Math.min(job.deadline, batch.deadline) - Date.now()),
        );
        job.timer.unref?.();
    };

    const run = (input) => {
        assertLive();
        if (
            totalBatches >= policy.sessionBatches ||
            (currentBatch && [...currentBatch.jobs.values()].some((job) => !quiet.has(job.state) && !job.disposition))
        ) {
            throw new DelegationError("Finish or cancel the active batch; session batch limits do not reset");
        }

        // validateOperation already validated and cloned the complete handoff.
        const packet = input.packet;
        if (packet.jobs.length > policy.batchJobs) {
            throw new DelegationError("Delegation batch job allowance exhausted");
        }

        const paths = [...new Set(packet.jobs.flatMap((job) => job.sources))];
        const snapshot = snapshotFactory(root, paths);
        const now = Date.now();
        const batch = {
            id: randomUUID(),
            generation,
            packet,
            packetDigest: digest({
                packet,
                sources: snapshot.sources,
                generation,
                hostId: enabledHost.id,
                model: enabledHost.model,
                policy,
            }),
            snapshot,
            host: enabledHost,
            model: enabledHost.model,
            deadline: now + policy.batchMs,
            calls: 0,
            cursor: 0,
            jobs: new Map(),
        };
        for (const spec of packet.jobs) {
            const job = {
                spec,
                state: "queued",
                settling: false,
                calls: 0,
                toolCalls: 0,
                toolBytes: 0,
                followUps: 0,
                revision: 0,
                cursor: 0,
                deadline: now + policy.jobMs,
                attemptId: randomUUID(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                usageReportedCalls: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
            batch.jobs.set(spec.id, job);
            armDeadline(batch, job);
        }

        if (currentBatch) {
            currentBatch.retired = true;
            cleanupBatch(currentBatch);
        }

        batches.set(batch.id, batch);
        totalBatches += 1;
        currentBatch = batch;
        pump();

        return summary(batch);
    };

    const mutate = (input) => {
        if (input.operation === "run") {
            return run(input);
        }

        if (input.operation === "cancel") {
            const batch = findBatch(input.batchId);
            if (input.jobId && !batch.jobs.has(input.jobId)) {
                throw new DelegationError("Unknown delegation job");
            }

            for (const job of batch.jobs.values()) {
                if (!input.jobId || input.jobId === job.spec.id) {
                    cancelJob(batch, job);
                }
            }

            pump();

            return summary(batch);
        }

        const { batch, job } = findBoundJob(input);
        if (input.operation === "follow_up") {
            if (
                job.settling ||
                job.followUps >= 1 ||
                job.disposition ||
                quiet.has(job.state) ||
                Date.now() >= Math.min(job.deadline, batch.deadline)
            ) {
                throw new DelegationError("Follow-up is unavailable for this receipt");
            }

            job.followUps += 1;
            job.followUpPrompt = input.prompt;
            job.attemptId = randomUUID();
            job.state = "queued";
            job.result = undefined;
            job.error = undefined;
            armDeadline(batch, job);
            pump();

            return summary(batch);
        }

        if (job.disposition) {
            throw new DelegationError("This result already has a final parent disposition");
        }

        const expected = job.result?.findings.map((finding) => finding.id) ?? [];
        const supplied = input.findings.map((finding) => finding.id);
        if (
            supplied.length !== expected.length ||
            new Set(supplied).size !== expected.length ||
            supplied.some((id) => !expected.includes(id))
        ) {
            throw new DelegationError("Disposition must account for each returned finding exactly once");
        }

        if (
            input.decision === "accept" &&
            (!job.result || input.findings.some((finding) => finding.decision === "needs_check"))
        ) {
            throw new DelegationError("Acceptance requires a result and checked finding dispositions");
        }

        const disposition = {
            decision: input.decision,
            findings: input.findings,
            authority: "parent assessment only; not human approval or task verification",
        };
        if (input.decision !== "needs_check") {
            job.disposition = disposition;
            releaseJob(job);
            cleanupBatch(batch);
        }

        return { ...binding(batch, job), disposition };
    };

    const execute = async (raw, signal) => {
        const input = validateOperation(raw);
        if (input.operation === "status") {
            if (enabled) {
                try {
                    assertLive();
                } catch {
                    // Status remains available after invalidation.
                }
            }

            return status();
        }

        if (input.operation === "collect") {
            const batch = findBatch(input.batchId);
            assertLive(batch);
            checkSources(batch);
            const cursor = input.afterCursor ?? 0;
            if (cursor > batch.cursor) {
                throw new DelegationError("Collection cursor is ahead of the batch");
            }

            if (
                input.waitMs &&
                batch.cursor === cursor &&
                [...batch.jobs.values()].some((job) => !terminal.has(job.state))
            ) {
                await new Promise((resolve) => {
                    let timer;
                    const done = () => {
                        clearTimeout(timer);
                        listeners.delete(done);
                        signal?.removeEventListener("abort", done);
                        resolve();
                    };

                    listeners.add(done);
                    timer = setTimeout(done, input.waitMs);
                    signal?.addEventListener("abort", done, { once: true });
                    if (signal?.aborted) {
                        done();
                    }
                });
            }

            assertLive(batch);
            checkSources(batch);

            return structuredClone({
                ...summary(batch),
                results: [...batch.jobs.values()]
                    .filter((job) => terminal.has(job.state) && job.cursor > cursor)
                    .map((job) => ({
                        receipt: {
                            ...binding(batch, job),
                            model: batch.model,
                            state: job.state,
                            settling: job.settling,
                            calls: job.calls,
                            toolCalls: job.toolCalls,
                            toolBytes: job.toolBytes,
                            usage: Object.fromEntries(
                                Object.entries(job.usage).map(([key, value]) => [
                                    key,
                                    job.usageReportedCalls[key] ? value : null,
                                ]),
                            ),
                            usageReportedCalls: job.usageReportedCalls,
                            usageComplete:
                                job.calls > 0 &&
                                Object.values(job.usageReportedCalls).every((count) => count === job.calls),
                            cost: null,
                        },
                        result: job.result ?? null,
                        error: job.error ?? null,
                        disposition: job.disposition ?? null,
                    })),
            });
        }

        const fingerprint = digest(input);
        const previous = requests.get(input.requestId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) {
                throw new DelegationError("A request identifier cannot be reused with a different payload");
            }

            if (input.operation !== "cancel") {
                assertLive();
                if (previous.generation !== generation) {
                    throw new DelegationError("Idempotent request belongs to a stale generation");
                }

                const batchId = input.batchId ?? previous.value?.batchId;
                if (batchId) {
                    checkSources(findBatch(batchId));
                }
            }

            if (previous.error) {
                throw new DelegationError(previous.error);
            }

            return structuredClone(previous.value);
        }

        if (requests.size >= 128) {
            throw new DelegationError("Session idempotency journal is full");
        }

        const entry = { fingerprint, generation };
        requests.set(input.requestId, entry);
        try {
            entry.value = mutate(input);

            return structuredClone(entry.value);
        } catch (error) {
            entry.error = publicErrorMessage(error);
            throw new DelegationError(entry.error);
        }
    };

    return {
        execute,
        status,
        invalidate,
        enable() {
            const host = getHost();
            const guard = getGuard();
            if (!host) {
                throw new DelegationError(
                    "Delegation has no Pi child-session host. Select a model before enabling delegation.",
                );
            }

            if (!host.isCurrent()) {
                throw new DelegationError(
                    "The Pi model or working directory changed during delegation setup. Restart Pi in the intended working directory.",
                );
            }

            if (guard === "locked") {
                throw new DelegationError(
                    "Command Guard is locked. Review /guard status and unlock it before delegating.",
                );
            }

            if (guard === "ambiguous") {
                throw new DelegationError(
                    "Multiple Command Guard instances replied. Load only one instance and restart Pi.",
                );
            }

            if (!["absent", "off", "guard", "strict"].includes(guard)) {
                throw new DelegationError(
                    "Command Guard has not reported a ready policy. Check /guard status and its startup errors.",
                );
            }

            if (enabled) {
                assertLive();

                return status();
            }

            enabledHost = host;
            enabledGuard = guard;
            enabled = true;
            generation += 1;

            return status();
        },
        policyFor(raw) {
            const input = validateOperation(raw);

            return {
                fingerprint: digest({
                    input,
                    generation,
                    enabled,
                    model: enabledHost?.model ?? null,
                    policy,
                    inference: "pi-agent-session-v1",
                }),
                summary: `Delegation ${input.operation}; bounded Pi sessions; enabled=${enabled}; generation=${generation}; selected model ${enabledHost?.model?.provider ?? "unavailable"}/${enabledHost?.model?.id ?? "unavailable"}; up to ${policy.concurrency} read-only workers, ${policy.sessionCalls} SDK inference invocations per Pi process, ${policy.jobMs / 1000}s per job. Pi owns configured authentication; temporary parent provider/auth overrides are unsupported. Child sessions use explicit thinking and selected text, without parent hooks or ambient extensions. Review and scout only. No shell, writes, recursive delegation or live web. Cancellation is best effort; SDK settlement does not establish remote termination or invoice bounds.`,
            };
        },
    };
}

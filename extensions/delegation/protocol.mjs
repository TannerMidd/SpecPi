import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({
    concurrency: 2,
    sessionBatches: 4,
    sessionCalls: 32,
    batchJobs: 2,
    batchCalls: 8,
    jobCalls: 4,
    jobMs: 120_000,
    batchMs: 300_000,
    contextBytes: 256 * 1024,
    retainedResponseBytes: 256 * 1024,
    toolBytes: 64 * 1024,
    toolCalls: 12,
    resultBytes: 16 * 1024,
    outputTokens: 8192,
});

export function bytes(value) {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

export function digest(value) {
    const canonical = (item) => {
        if (Array.isArray(item)) {
            return item.map(canonical);
        }

        if (item && typeof item === "object") {
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => [key, canonical(item[key])]),
            );
        }

        return item;
    };

    return createHash("sha256")
        .update(JSON.stringify(canonical(value)))
        .digest("hex");
}

export function record(value, keys, required = keys) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        required.some((key) => !Object.hasOwn(value, key))
    ) {
        throw new Error("Invalid closed delegation object");
    }

    return value;
}

export function text(value, max = 4000, empty = false) {
    if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0")) {
        throw new Error("Invalid delegation text");
    }

    return value;
}

function identifier(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value)) {
        throw new Error("Invalid delegation identifier");
    }

    return value;
}

export function list(value, max, check) {
    if (!Array.isArray(value) || value.length > max) {
        throw new Error("Invalid delegation list");
    }

    value.forEach(check);

    return value;
}

export function integer(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error("Invalid delegation integer");
    }

    return value;
}

export function validatePacket(packet) {
    record(packet, ["objective", "requirements", "decisions", "nonGoals", "reason", "jobs"]);
    text(packet.objective);
    list(packet.requirements, 24, (item) => {
        record(item, ["id", "text"]);
        identifier(item.id);
        text(item.text, 2000);
    });
    if (
        !packet.requirements.length ||
        new Set(packet.requirements.map((item) => item.id)).size !== packet.requirements.length
    ) {
        throw new Error("Requirements must have unique identifiers");
    }

    list(packet.decisions, 24, (item) => text(item, 2000));
    list(packet.nonGoals, 24, (item) => text(item, 2000));
    record(packet.reason, ["benefit", "why", "parentWork"]);
    if (!["independent_review", "parallel_analysis", "context_isolation"].includes(packet.reason.benefit)) {
        throw new Error("Delegation is limited to independent review or selected-source analysis");
    }

    text(packet.reason.why, 2000);
    text(packet.reason.parentWork, 2000, packet.reason.benefit !== "parallel_analysis");
    list(packet.jobs, LIMITS.batchJobs, (job) => {
        record(job, ["id", "mode", "question", "context", "sources", "requirements"]);
        identifier(job.id);
        if (!["review", "scout"].includes(job.mode)) {
            throw new Error("Unsupported delegation mode");
        }

        text(job.question, 8000);
        text(job.context, 128 * 1024, true);
        list(job.sources, 200, (source) => text(source, 500));
        list(job.requirements, packet.requirements.length, identifier);
        if (
            !job.requirements.length ||
            new Set(job.requirements).size !== job.requirements.length ||
            job.requirements.some((id) => !packet.requirements.some((requirement) => requirement.id === id))
        ) {
            throw new Error("Each worker needs a unique subset of the packet requirement IDs");
        }

        if ((packet.reason.benefit === "independent_review") !== (job.mode === "review")) {
            throw new Error("The worker mode must match the declared delegation benefit");
        }

        if (!job.context.trim() && !job.sources.length) {
            throw new Error("A worker needs a frozen artifact or selected evidence to examine");
        }

        if (job.mode === "scout" && !job.sources.length) {
            throw new Error("A scout requires explicitly selected source files");
        }
    });
    if (
        !packet.jobs.length ||
        new Set(packet.jobs.map((job) => job.id)).size !== packet.jobs.length ||
        bytes(packet) > LIMITS.contextBytes
    ) {
        throw new Error("Delegation packet exceeds its bound or repeats job identifiers");
    }

    if (new Set(packet.jobs.map((job) => job.question.trim().toLowerCase())).size !== packet.jobs.length) {
        throw new Error("Assign distinct worker questions instead of duplicate answers");
    }

    return structuredClone(packet);
}

const bindingKeys = ["batchId", "jobId", "attemptId", "packetDigest", "generation", "resultRevision"];

export function validateOperation(input) {
    const operations = {
        run: ["operation", "requestId", "packet"],
        status: ["operation"],
        collect: ["operation", "batchId", "afterCursor", "waitMs"],
        follow_up: ["operation", "requestId", ...bindingKeys, "prompt"],
        resolve: ["operation", "requestId", ...bindingKeys, "decision", "findings"],
        cancel: ["operation", "requestId", "batchId", "jobId"],
    };
    if (!operations[input?.operation]) {
        throw new Error("Unsupported delegation operation");
    }

    const optional =
        input.operation === "collect" ? ["afterCursor", "waitMs"] : input.operation === "cancel" ? ["jobId"] : [];
    record(
        input,
        operations[input.operation],
        operations[input.operation].filter((key) => !optional.includes(key)),
    );
    if (bytes(input) > LIMITS.contextBytes + 4096) {
        throw new Error("Delegation operation exceeds its bound");
    }

    for (const key of ["requestId", "batchId", "jobId", "attemptId"]) {
        if (input[key] !== undefined) {
            identifier(input[key]);
        }
    }

    if (input.operation === "run") {
        validatePacket(input.packet);
    }

    if (input.operation === "collect") {
        integer(input.afterCursor ?? 0, 0, Number.MAX_SAFE_INTEGER);
        integer(input.waitMs ?? 0, 0, 30_000);
    }

    if (["follow_up", "resolve"].includes(input.operation)) {
        if (!/^[a-f0-9]{64}$/u.test(input.packetDigest)) {
            throw new Error("Invalid packet digest");
        }

        integer(input.generation, 0, Number.MAX_SAFE_INTEGER);
        integer(input.resultRevision, 1, Number.MAX_SAFE_INTEGER);
    }

    if (input.operation === "follow_up") {
        text(input.prompt, 8000);
    }

    if (input.operation === "resolve") {
        if (!["accept", "discard", "needs_check"].includes(input.decision)) {
            throw new Error("Invalid parent disposition");
        }

        list(input.findings, 8, (finding) => {
            record(finding, ["id", "decision"]);
            identifier(finding.id);
            if (!["confirmed", "rejected", "needs_check"].includes(finding.decision)) {
                throw new Error("Invalid finding disposition");
            }
        });
    }

    return structuredClone(input);
}

export function validateResult(result, { requirements, sources }) {
    record(result, ["status", "answer", "requirements", "findings", "missing", "nextStep"]);
    if (bytes(result) > LIMITS.resultBytes || !["complete", "partial", "needs_context"].includes(result.status)) {
        throw new Error("Invalid worker result size or status");
    }

    text(result.answer, 12_000, true);
    text(result.nextStep, 2000, true);
    list(result.missing, 16, (item) => text(item, 1000));
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const evidence = (item) => {
        record(item, ["sourceId", "lineStart", "lineEnd"]);
        const source = sourceMap.get(item.sourceId);
        if (!source) {
            throw new Error("Worker referenced an unknown source");
        }

        integer(item.lineStart, 1, source.lineCount);
        integer(item.lineEnd, item.lineStart, source.lineCount);
    };

    list(result.requirements, requirements.length, (item) => {
        record(item, ["id", "status", "evidence"]);
        if (
            !requirements.some((requirement) => requirement.id === item.id) ||
            !["addressed", "unaddressed"].includes(item.status)
        ) {
            throw new Error("Worker requirement coverage is invalid");
        }

        list(item.evidence, 8, evidence);
    });
    if (new Set(result.requirements.map((item) => item.id)).size !== requirements.length) {
        throw new Error("Worker must cover each requirement exactly once");
    }

    list(result.findings, 8, (finding) => {
        record(finding, ["id", "claim", "confidence", "evidence", "contraryEvidence"]);
        identifier(finding.id);
        text(finding.claim, 2000);
        if (!["observed", "inferred", "unverified"].includes(finding.confidence)) {
            throw new Error("Invalid finding confidence");
        }

        list(finding.evidence, 8, evidence);
        list(finding.contraryEvidence, 8, evidence);
        if (finding.confidence === "observed" && !finding.evidence.length) {
            throw new Error("Observed findings require a source reference");
        }
    });
    if (new Set(result.findings.map((finding) => finding.id)).size !== result.findings.length) {
        throw new Error("Worker finding identifiers must be unique");
    }

    return structuredClone(result);
}

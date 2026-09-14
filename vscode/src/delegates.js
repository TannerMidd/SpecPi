"use strict";

const { stripVTControlCharacters } = require("node:util");
const DELEGATE_WIDGET = "specpi-delegation-v1";
const states = new Set([
    "queued",
    "running",
    "complete",
    "partial",
    "needs_context",
    "failed",
    "cancelled",
    "expired",
    "stale",
]);
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/u.test(value);
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value, max = 512) =>
    typeof value === "string"
        ? stripVTControlCharacters(value.slice(0, max))
              .replace(/[\p{Cc}\p{Cf}]/gu, " ")
              .trim()
        : "";

function decodeDelegates(lines) {
    if (
        !Array.isArray(lines) ||
        lines.length !== 1 ||
        typeof lines[0] !== "string" ||
        lines[0].length > 32_768 ||
        Buffer.byteLength(lines[0], "utf8") > 32_768
    ) {
        return null;
    }

    let value;
    try {
        value = JSON.parse(lines[0]);
    } catch {
        return null;
    }

    if (
        !value ||
        value.version !== 1 ||
        typeof value.enabled !== "boolean" ||
        ![value.active, value.concurrency, value.calls, value.callLimit].every(counter) ||
        value.concurrency < 1 ||
        value.concurrency > 8 ||
        value.active > value.concurrency ||
        !Array.isArray(value.jobs) ||
        value.jobs.length > 8
    ) {
        return null;
    }

    const jobs = [];
    const seen = new Set();
    for (const job of value.jobs) {
        if (
            !job ||
            ![job.id, job.batchId, job.attemptId].every(identifier) ||
            !["review", "scout"].includes(job.mode) ||
            !states.has(job.state) ||
            typeof job.settling !== "boolean" ||
            ![job.calls, job.tools, job.elapsedMs].every(counter) ||
            ![null, "accept", "discard", "needs_check"].includes(job.disposition)
        ) {
            return null;
        }

        const key = `${job.batchId}/${job.id}/${job.attemptId}`;
        if (seen.has(key)) {
            return null;
        }

        seen.add(key);
        jobs.push({
            id: job.id,
            batchId: job.batchId,
            attemptId: job.attemptId,
            mode: job.mode,
            state: job.state,
            settling: job.settling,
            calls: job.calls,
            tools: job.tools,
            elapsedMs: job.elapsedMs,
            disposition: job.disposition,
            task: plain(job.task, 240),
            provider: plain(job.provider, 128),
            model: plain(job.model, 128),
            error: plain(job.error, 512),
        });
    }

    return {
        enabled: value.enabled,
        active: value.active,
        concurrency: value.concurrency,
        calls: value.calls,
        callLimit: value.callLimit,
        jobs,
    };
}

function workerState(job) {
    if (job.settling && !["queued", "running"].includes(job.state)) {
        return ["complete", "partial", "needs_context"].includes(job.state) ? "Finishing" : "Stopping";
    }

    return (
        {
            complete: "Ready for parent review",
            partial: "Partial result",
            needs_context: "Needs context",
            cancelled: "Stopped",
            stale: "Invalidated",
            expired: "Timed out",
            failed: "Failed",
            queued: "Queued",
            running: "Running",
        }[job.state] || "Unknown"
    );
}

// Human-readable projection of SpecPi's existing delegate tool receipts. Raw
// payloads remain in Pi; no findings or success are invented from a finished tool call.
function delegateResultText(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    const lines = [];
    if (typeof value.enabled === "boolean" && counter(value.active)) {
        lines.push(`Delegation ${value.enabled ? "enabled" : "off or paused"} · ${value.active} occupied worker slots`);
    }

    if (identifier(value.jobId) && value.disposition?.decision) {
        lines.push(`${value.jobId} · Parent assessment: ${plain(value.disposition.decision, 32)}`);
        lines.push("Parent assessment is not human approval or verified completion.");
    }

    for (const job of Array.isArray(value.jobs) ? value.jobs.slice(0, 8) : []) {
        if (identifier(job?.jobId) && states.has(job.state) && counter(job.calls)) {
            lines.push(`${job.jobId} · ${workerState(job)} · ${job.calls} model calls`);
        }
    }

    for (const item of Array.isArray(value.results) ? value.results.slice(0, 8) : []) {
        if (!identifier(item?.receipt?.jobId)) {
            continue;
        }

        const name = item.receipt.jobId;
        if (item.result && ["complete", "partial", "needs_context"].includes(item.result.status)) {
            lines.push(`\n${name} · Advisory report`, plain(item.result.answer, 2400));
            for (const finding of Array.isArray(item.result.findings) ? item.result.findings.slice(0, 8) : []) {
                if (finding && typeof finding.claim === "string") {
                    lines.push(`• ${plain(finding.claim, 600)}`);
                }
            }

            if (item.result.nextStep) {
                lines.push(`Next: ${plain(item.result.nextStep, 600)}`);
            }
        } else if (typeof item.error === "string") {
            lines.push(`${name} · ${plain(item.error, 512)}`);
        }
    }

    if (!lines.length) {
        return null;
    }

    return `${lines.filter(Boolean).join("\n")}\n\nReported snapshot, not proof of task completion.`.slice(0, 16_000);
}

function delegateCompletionText(job) {
    const seconds = Math.floor(job.elapsedMs / 1000);

    return [
        `Delegate ${job.id} · ${workerState(job)}`,
        job.task,
        `${Math.floor(seconds / 60)}m ${seconds % 60}s · ${job.calls} model calls · ${job.tools} source-tool calls`,
        job.error,
        job.disposition ? `Parent assessment: ${job.disposition}` : "",
        "Advisory status, not verified task completion or proof of remote termination.",
    ]
        .filter(Boolean)
        .join("\n");
}

module.exports = { DELEGATE_WIDGET, decodeDelegates, delegateResultText, delegateCompletionText };

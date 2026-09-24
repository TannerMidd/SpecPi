"use strict";

const { stripVTControlCharacters } = require("node:util");

// SpecPi's background-jobs extension publishes this widget to RPC clients only: one JSON line
// holding what /jobs already lists. Anything that does not match is dropped, not repaired.
const JOBS_WIDGET = "specpi-background-v1";
const MAX_JOBS = 8;
const STATES = new Set(["running", "exited", "stopped", "failed"]);

const plain = (value, max) =>
    typeof value === "string"
        ? stripVTControlCharacters(value.slice(0, max))
              .replace(/[\p{Cc}\p{Cf}]/gu, " ")
              .trim()
        : "";
const time = (value) => Number.isSafeInteger(value) && value > 0;

function decodeBackgroundJobs(lines) {
    if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string" || lines[0].length > 16_384) {
        return null;
    }

    let value;
    try {
        value = JSON.parse(lines[0]);
    } catch {
        return null;
    }

    if (!value || value.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length > MAX_JOBS) {
        return null;
    }

    const jobs = [];
    const seen = new Set();
    for (const job of value.jobs) {
        if (
            !job ||
            typeof job.id !== "string" ||
            !/^\d{1,9}$/u.test(job.id) ||
            seen.has(job.id) ||
            !STATES.has(job.state) ||
            !time(job.startedAt) ||
            !(job.endedAt === null || time(job.endedAt)) ||
            !(job.exitCode === null || Number.isSafeInteger(job.exitCode))
        ) {
            return null;
        }

        seen.add(job.id);
        jobs.push({
            id: job.id,
            label: plain(job.label, 80),
            command: plain(job.command, 240),
            state: job.state,
            exitCode: job.exitCode,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
        });
    }

    return { jobs };
}

module.exports = { JOBS_WIDGET, decodeBackgroundJobs };

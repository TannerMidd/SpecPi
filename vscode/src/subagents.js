"use strict";

const { stripVTControlCharacters } = require("node:util");
const SUBAGENT_WIDGET = "specpi-chat-subagents-v1";
const MAX_AGENTS = 16;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit = 240) =>
    typeof value === "string"
        ? stripVTControlCharacters(value.slice(0, limit))
              .replace(/[\p{Cc}\p{Cf}]/gu, " ")
              .trim()
        : "";
const metric = (value) => (count(value) ? value : null);

// pi-subagents 0.67.0's public fleetStatus v1 DTO. Keys are display identities,
// never run IDs or authority for a control action. No private run data is forwarded.
function projectFleet(value) {
    if (
        value?.version !== 1 ||
        !Array.isArray(value.entries) ||
        value.entries.length > MAX_AGENTS ||
        !count(value.totalActive) ||
        !count(value.omitted) ||
        value.totalActive !== value.entries.length + value.omitted
    ) {
        return null;
    }

    const entries = [];
    const keys = new Set();
    for (const entry of value.entries) {
        if (
            typeof entry?.key !== "string" ||
            !entry.key ||
            entry.key.length > 128 ||
            text(entry.key, 128) !== entry.key ||
            keys.has(entry.key) ||
            !text(entry.agent, 96) ||
            !count(entry.startedAt) ||
            entry.startedAt > 8_640_000_000_000_000 ||
            ![entry.tokens?.input, entry.tokens?.output, entry.tokens?.total].every(count)
        ) {
            return null;
        }

        keys.add(entry.key);
        entries.push({
            key: entry.key,
            agent: text(entry.agent, 96),
            role: text(entry.role, 96),
            model: text(entry.model, 128),
            effort: text(entry.effort, 32),
            goal: text(entry.goal, 512),
            startedAt: entry.startedAt,
            tokens: { input: entry.tokens.input, output: entry.tokens.output, total: entry.tokens.total },
        });
    }

    const result = { version: 1, entries, totalActive: value.totalActive, omitted: value.omitted };
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > 32_768) {
        result.entries.pop();
        result.omitted += 1;
    }

    return result;
}

function decodeFleet(lines) {
    if (
        !Array.isArray(lines) ||
        lines.length !== 1 ||
        typeof lines[0] !== "string" ||
        Buffer.byteLength(lines[0], "utf8") > 32_768
    ) {
        return null;
    }

    try {
        return projectFleet(JSON.parse(lines[0]));
    } catch {
        return null;
    }
}

function resultState(result, progress, running) {
    if (result.timedOut === true) {
        return "timed_out";
    }

    if (result.stopped === true) {
        return "stopped";
    }

    if (result.interrupted === true) {
        return "interrupted";
    }

    if (result.detached === true || progress.status === "detached") {
        return "detached";
    }

    if (running && ["pending", "running", "completed", "failed"].includes(progress.status)) {
        return progress.status === "pending" ? "queued" : progress.status;
    }

    if (typeof result.exitCode === "number" && Number.isInteger(result.exitCode) && result.exitCode >= 0) {
        return result.exitCode === 0 ? "completed" : "failed";
    }

    return running ? "running" : "unknown";
}

// Project only display metadata from ordinary tool receipts. Child messages,
// session paths, tool arguments, artifacts, and workflow scripts stay out of cards.
function projectSubagentDetails(details, running = false) {
    if (!details || !["single", "parallel", "chain", "workflow", "management"].includes(details.mode)) {
        return null;
    }

    const results = Array.isArray(details.results) ? details.results : [];
    const progress = Array.isArray(details.progress) ? details.progress.slice(0, 256) : [];
    const sources = results.length ? results : progress;
    const rows = [];
    const seen = new Set();
    for (const [offset, result] of sources.slice(0, MAX_AGENTS).entries()) {
        if (!result || typeof result !== "object") {
            continue;
        }

        const index = count(result.index) ? result.index : offset;
        if (seen.has(index) || !text(result.agent, 96)) {
            continue;
        }

        seen.add(index);
        const live = progress.find((item) => item?.index === index) || result.progress || result.progressSummary || {};
        const current = results.length ? live : result;
        rows.push({
            index,
            agent: text(result.agent, 96),
            task: text(result.task || current.task),
            state: resultState(results.length ? result : {}, current, running),
            model: text(result.model || current.model, 128),
            effort: text(result.thinking || current.thinking, 32),
            tokens: metric(current.tokens ?? result.usage?.totalTokens),
            tools: metric(current.toolCount),
            elapsedMs: metric(current.durationMs),
            currentTool: text(current.currentTool, 96),
            error: text(result.error || current.error, 512),
        });
    }

    const background = typeof details.asyncId === "string" || details.background === true;
    if (!rows.length && !background) {
        return null;
    }

    return {
        mode: details.mode,
        background,
        rows,
        omitted: Math.max(0, sources.length - MAX_AGENTS),
    };
}

module.exports = { SUBAGENT_WIDGET, projectFleet, decodeFleet, projectSubagentDetails };

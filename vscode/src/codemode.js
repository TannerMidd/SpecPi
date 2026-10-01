"use strict";

// Display helpers for Pi's codemode tool. A codemode call runs a model-written script whose tool
// calls happen inside the script: Pi reports them as nested tool events (with parentToolCallId) and
// as `details.calls` on the codemode result. Chat shows them as one card with the script, a list of
// the calls it made and the script's output, as Pi's own terminal renderer does, rather than as
// separate tool cards the model never saw.

const { stripVTControlCharacters } = require("node:util");

const CODEMODE_TOOL = "codemode";
const MAX_CALLS = 100;
const MAX_CALL_NAME = 128;
const MAX_CALL_ARGS = 400;
const MAX_CALL_ERROR = 600;
const STATUSES = new Set(["running", "ok", "error", "cancelled"]);
const SCRIPT_HEADER = /^Script (completed|failed)\r?\nWall time ([\d.]+) seconds\r?\nOutput:\r?\n?$/u;

function plain(value, max) {
    if (typeof value !== "string") {
        return "";
    }

    const text = stripVTControlCharacters(value.length > max * 2 ? value.slice(0, max * 2) : value)
        .replace(/[^\P{Cc}\n\t]/gu, " ")
        .replace(/\p{Cf}/gu, "");

    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function argsText(call) {
    if (typeof call.args === "string") {
        return call.args;
    }

    // Pi's bounded session record (`nestedCalls`) keeps arguments as an object.
    if (call.arguments !== undefined) {
        try {
            return JSON.stringify(call.arguments);
        } catch {
            return "";
        }
    }

    return "";
}

function finiteNonNegative(value) {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The nested calls of a codemode result, newest last, bounded for display. Reads `details.calls`
 * (live updates and stored results) and falls back to the session's `nestedCalls` record.
 */
function codemodeCalls(details, nestedCalls) {
    const source = Array.isArray(details?.calls)
        ? details.calls
        : Array.isArray(nestedCalls?.calls)
          ? nestedCalls.calls
          : [];
    const kept = source.slice(-MAX_CALLS);
    const calls = [];
    for (const call of kept) {
        if (!call || typeof call !== "object") {
            continue;
        }

        const name = plain(call.name, MAX_CALL_NAME);
        if (!name) {
            continue;
        }

        const entry = {
            name,
            status: STATUSES.has(call.status) ? call.status : "running",
            args: plain(argsText(call), MAX_CALL_ARGS),
        };
        const durationMs = finiteNonNegative(call.durationMs);
        if (durationMs !== undefined) {
            entry.durationMs = durationMs;
        }

        const cost = finiteNonNegative(call.cost);
        if (cost) {
            entry.cost = cost;
        }

        const error = plain(call.error, MAX_CALL_ERROR);
        if (error && entry.status !== "ok") {
            entry.error = error;
        }

        calls.push(entry);
    }

    return { calls, omitted: source.length - kept.length };
}

/** Splits Pi's "Script completed / Wall time / Output:" header from the script's own output. */
function codemodeOutput(content) {
    if (!Array.isArray(content) || content[0]?.type !== "text" || typeof content[0].text !== "string") {
        return { content };
    }

    const match = SCRIPT_HEADER.exec(content[0].text);
    if (!match) {
        return { content };
    }

    return { content: content.slice(1), wallSeconds: Number(match[2]), failed: match[1] === "failed" };
}

/** The script itself, shown as code instead of the `{ "code": ... }` JSON of the tool arguments. */
function codemodeScript(args) {
    return typeof args?.code === "string" ? args.code.replace(/\r\n?/gu, "\n").trimEnd() : undefined;
}

function isCodemode(toolName) {
    return toolName === CODEMODE_TOOL;
}

function callsDisplayLength(message) {
    return Array.isArray(message.calls)
        ? message.calls.reduce(
              (total, call) => total + call.name.length + call.args.length + (call.error?.length || 0),
              0,
          )
        : 0;
}

module.exports = {
    CODEMODE_TOOL,
    MAX_CALLS,
    MAX_CALL_ARGS,
    MAX_CALL_ERROR,
    callsDisplayLength,
    codemodeCalls,
    codemodeOutput,
    codemodeScript,
    isCodemode,
};

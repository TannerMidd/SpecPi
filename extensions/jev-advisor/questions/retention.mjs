// System 1: decide whether a large read-only tool result is worth carrying for the rest of the
// session.
//
// Measured against the recorded eval runs, fresh input is ~6% of SpecPi's prompt tokens and ~76%
// of its input spend, and it grows superlinearly with difficulty: tier 3 attempts burn 31,593
// fresh tokens against tier 2's 5,100. Accumulated tool results are that growth.
//
// The decision happens on arrival, before the result is appended. Condensing afterwards would
// rewrite a cached prefix: simulated over the recorded token series, on-arrival condensing is worth
// about -61% of long-attempt cost against -12% for a retroactive batch rewrite. Same classifier,
// five times the return, because the prefix is never invalidated.
//
// Jev decides *whether*. Code does the transformation, so the digest is deterministic and testable
// and no model-written prose ever enters the transcript.

import { choice, noul, score } from "../client.mjs";
import { nounFalse, scoreLevel } from "../gate.mjs";
import { compact, outline } from "../sanitize.mjs";

/** Results below this never justify a call: the saving cannot exceed the overhead. */
export const MIN_RESULT_BYTES = 4096;

// Only tools that observe. A write or edit result is a record of a mutation, and eliding it would
// hide what the session did to the worktree from every later turn.
export const ELIGIBLE_TOOLS = Object.freeze(new Set(["read", "grep", "find", "ls", "bash", "powershell"]));

export const RELEVANCE_LEVELS = Object.freeze([
    "Spent: a dead end, or already superseded by a later result",
    "Background: might be referenced again but is not being acted on",
    "Load-bearing: the task is currently proceeding from this output",
]);

export function eligible(event) {
    if (!event || event.isError === true || !ELIGIBLE_TOOLS.has(event.toolName)) {
        return false;
    }

    return resultBytes(event) >= MIN_RESULT_BYTES;
}

export function resultText(event) {
    return (event?.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

export function resultBytes(event) {
    return Buffer.byteLength(resultText(event), "utf8");
}

/**
 * Cross-result context is the one thing a per-result decision loses: six greps where the fourth
 * found the answer can only be judged as a set. `recent` carries a rolling digest of the last few
 * decisions so that judgement is available without waiting for a batch that would have to rewrite
 * history to be useful.
 */
export function buildInput({ event, objective, recent = [] }) {
    return {
        tool: event.toolName,
        arguments: compact(JSON.stringify(event.input ?? {}), 160),
        objective: compact(objective ?? "", 180),
        result: outline(resultText(event)),
        recent: recent.slice(-4).map((item) => compact(`${item.tool}: ${item.outcome}`, 60)),
    };
}

export function questions() {
    return {
        future_relevance: score(
            "How much will the rest of this task still need this tool output, given the objective?",
            RELEVANCE_LEVELS,
        ),
        contains_the_answer: noul("This output contains the specific fact the task was looking for"),
        result_kind: choice("What kind of output is this?", {
            listing: "A directory listing or file enumeration",
            search: "Search or grep matches",
            file: "The contents of a file",
            log: "Build, test or command output",
            error: "A failure report or stack trace",
            other: "Anything else",
        }),
    };
}

/**
 * Elide only when the model is confident on both counts and they agree. A high relevance score or
 * any signal that the answer is in here keeps the result whole: the asymmetry is deliberate, since
 * carrying a result costs tokens but dropping the wrong one costs the task.
 */
export function decide(answers) {
    const level = scoreLevel(answers?.future_relevance, "retention");
    if (level !== 0) {
        return { elide: false, reason: "relevance-ungated-or-high" };
    }

    if (!nounFalse(answers?.contains_the_answer, "retention")) {
        return { elide: false, reason: "may-contain-answer" };
    }

    return { elide: true, reason: "spent" };
}

/**
 * The replacement body. Head and tail are kept because the shape of an output is often what a
 * later turn needs, and the notice tells the model the material is recoverable so it re-runs
 * rather than guessing.
 */
export function digest(text, { tool, bytes }) {
    const lines = String(text ?? "").split(/\r?\n/u);
    const head = lines.slice(0, 12);
    const tail = lines.length > 20 ? lines.slice(-4) : [];
    const hidden = Math.max(0, lines.length - head.length - tail.length);

    return [
        ...head,
        ...(hidden > 0 ? ["", `[SpecPi elided ${hidden} lines (${bytes} bytes) of ${tool} output.`] : []),
        ...(hidden > 0
            ? ["Judged spent for this task. Re-run the command if you need the full output again.]", ""]
            : []),
        ...tail,
    ].join("\n");
}

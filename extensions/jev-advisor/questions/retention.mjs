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
//
// WHAT IT ACTUALLY DOES, MEASURED. Once the ledger could record outcomes rather than only calls,
// five live runs of `t3-cascade-ledger` said this system asks three or four times per attempt and
// has never once shortened anything. Every decline was the same: the Score gate found the answer
// ungated, and specifically `relevance-low-confidence` -- Jev answered, and reported a confidence
// below the calibrated 0.60.
//
// Those historical calls did not reliably include the objective or result samples: the old
// integration could lose both. They establish no benefit, but cannot isolate classifier quality.
// The repaired inputs need new controlled measurements; the thresholds remain unchanged.
// Carrying a result costs tokens, while dropping the wrong evidence can cost the task.
//
// So the honest statement is that retention does not pay off on this workload, and it is now
// possible to say that from a report rather than infer it from a cost delta. Whether it pays off on
// a workload with genuinely disposable output -- a session that greps widely before settling, or
// one that fetches pages it reads once -- is untested, and widening the eligible tool set to cover
// fetched content was done partly to find out.

import { noul, score } from "../client.mjs";
import { nounFalse, scoreLevel, thresholdsFor } from "../gate.mjs";
import { compact, outline } from "../sanitize.mjs";

/** Results below this never justify a call: the saving cannot exceed the overhead. */
export const MIN_RESULT_BYTES = 4096;

// Shell commands are excluded: success does not prove read-only execution or safe re-running.
// Only tools that observe, and not `read`: the agent asked for that file's contents, so on arrival
// it is load-bearing by construction. Measured over the 22 Sep Terminal-Bench 2 sittings, every
// one of retention's 39 calls was a `read`, none shortened anything, and half came back with
// confidence 0 -- calls spent on a question whose answer was fixed before it was asked.
// A write or edit result is a record of a mutation, and eliding it would
// hide what the session did to the worktree from every later turn.
//
// The second group is the one this system was always described as covering and did not. Fetched
// pages, search bodies, browser snapshots and accessibility trees are the largest results anything
// in SpecPi produces and the least likely to be load-bearing twice: a page is read for one fact, an
// accessibility tree is a photograph of a DOM that has since changed. A delegation report is here
// for the same reason -- it is a child session's answer, already distilled once, and re-reading it
// ten turns later is not how it gets used.
//
// Nothing here mutates the worktree. `delegate` spawns a read-only child, and the browser tools act
// on a page rather than on files, so the rule above is intact rather than bent.
export const ELIGIBLE_TOOLS = Object.freeze(
    new Set([
        "grep",
        "find",
        "ls",
        "web_search",
        "fetch_content",
        "get_search_content",
        "browser_snapshot",
        "browser_accessibility",
        "browser_diagnostics",
        "delegate",
    ]),
);

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
    };
}

/** Which half of the Score gate refused. Reported to the ledger, never used to bypass anything. */
function ungatedReason(answers) {
    const answer = answers?.future_relevance;
    if (answer?.kind !== "score" || typeof answer.confidence !== "number") {
        return "relevance-no-answer";
    }

    const limits = thresholdsFor("retention");
    if (answer.confidence < limits.scoreConfidence) {
        return "relevance-low-confidence";
    }

    return "relevance-straddles-boundary";
}

/**
 * Elide only when the model is confident on both counts and they agree. A high relevance score or
 * any signal that the answer is in here keeps the result whole: the asymmetry is deliberate, since
 * carrying a result costs tokens but dropping the wrong one costs the task.
 */
export function decide(answers) {
    const level = scoreLevel(answers?.future_relevance, "retention");
    if (level !== 0) {
        // Three different declines, and conflating them hid the one that mattered. "The model judged
        // this result still useful" is the system working. "The gate refused an answer the model did
        // give" is the system being unreachable, which is how the 0.80 confidence threshold survived
        // unnoticed until it was measured -- and a gate has two halves, so which half refused is the
        // difference between a threshold to move and a question the model genuinely cannot answer.
        return { elide: false, reason: level === undefined ? ungatedReason(answers) : "relevance-high" };
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

// System 1b: guide compaction, which is the one moment the prompt cache is discarded anyway.
//
// Pi's `findCutPoint` is documented as "walk backwards from newest, accumulating estimated message
// sizes, stop when we've accumulated >= keepRecentTokens". It is a token ruler: it cannot tell the
// load-bearing finding from six dead-end greps, and it discards whichever falls on the wrong side
// of the line. Since the prefix is being rebuilt regardless, improving that choice costs nothing.
//
// This system never sets the cut itself. It supplies `customInstructions` — an existing documented
// parameter on the compaction path — so the summariser is told what this session was actually
// about. The token budget still bounds the result, so bad advice can shape a summary, never blow
// the budget or drop an entry the preparation meant to keep.

import { choice, noul } from "../client.mjs";
import { choiceValue, nounTrue } from "../gate.mjs";
import { compact } from "../sanitize.mjs";

export const WORK_KINDS = Object.freeze({
    debugging: "Tracking down why something fails",
    building: "Adding or changing a feature",
    refactoring: "Restructuring code without changing behaviour",
    research: "Reading and answering questions about a codebase",
    testing: "Writing or repairing tests",
    ops: "Builds, releases, configuration or tooling",
    review: "Reading a diff and judging it",
});

/**
 * A digest of what compaction is about to discard: entry kinds and scale, never their text. The
 * summariser still sees the real conversation; this only steers what it keeps.
 */
export function buildInput({ preparation, objective }) {
    const messages = preparation?.messagesToSummarize ?? [];
    const kinds = {};
    for (const message of messages) {
        const role = typeof message?.role === "string" ? message.role : "unknown";
        kinds[role] = (kinds[role] ?? 0) + 1;
    }

    const files = preparation?.fileOps ?? {};

    return {
        objective: compact(objective ?? "", 180),
        discarding: messages.length,
        roles: kinds,
        tokensBefore: preparation?.tokensBefore ?? 0,
        splitTurn: preparation?.isSplitTurn === true,
        filesRead: [...(files.read ?? [])].slice(0, 12).map((item) => compact(item, 60)),
        filesWritten: [...(files.written ?? []), ...(files.edited ?? [])].slice(0, 12).map((item) => compact(item, 60)),
        hadPreviousSummary: typeof preparation?.previousSummary === "string",
    };
}

export function questions() {
    return {
        work_kind: choice("What kind of work has this session mostly been doing?", WORK_KINDS),
        unresolved_thread: noul("There is an unfinished investigation whose findings must survive compaction"),
        discarded_span_was_dead_ends: noul(
            "The work being discarded was mostly abandoned attempts that led nowhere useful",
        ),
    };
}

const FOCUS = Object.freeze({
    debugging: "the symptom, what has been ruled out, and the current hypothesis",
    building: "what has been implemented so far and what remains",
    refactoring: "the invariants being preserved and which call sites have been updated",
    research: "the questions answered so far, with the files each answer came from",
    testing: "which tests exist, which fail, and why",
    ops: "the commands run, their outcomes, and the current configuration state",
    review: "the findings raised so far and their severity",
});

/**
 * Build `customInstructions` from gated answers only. With nothing gated this returns undefined and
 * Pi's own default prompt is used unchanged.
 */
export function decide(answers) {
    const kind = choiceValue(answers?.work_kind, "compaction");
    const unresolved = nounTrue(answers?.unresolved_thread, "compaction");
    const deadEnds = nounTrue(answers?.discarded_span_was_dead_ends, "compaction");
    const parts = [];
    if (kind && FOCUS[kind]) {
        parts.push(`This session has mainly been ${kind}. Prioritise ${FOCUS[kind]}.`);
    }

    if (unresolved) {
        parts.push(
            "An investigation is still open. Preserve its findings and the current hypothesis in full, even at the cost of earlier detail.",
        );
    }

    if (deadEnds) {
        parts.push(
            "Most of the discarded work was abandoned attempts. Record what was ruled out in one line each rather than recounting them, so the same paths are not retried.",
        );
    }

    if (parts.length === 0) {
        return { customInstructions: undefined, deadEnds, unresolved };
    }

    return { customInstructions: parts.join(" "), deadEnds, unresolved };
}

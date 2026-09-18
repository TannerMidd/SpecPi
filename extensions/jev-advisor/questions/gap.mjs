// System 2: triage a capability-gap report before it is written.
//
// This fixes two real defects in the improvement loop rather than saving tokens.
//
// Fragmentation: `aggregateEvents` groups by exact `canonicalKey` string, with manual alias
// decisions as the only correction, and qualification needs `priority >= blocked || occurrences
// >= 2`. A genuinely recurring problem that the model names differently each time fragments into
// singletons and can stay permanently unqualified — it never reaches the human at
// /harness-improvement. Lexical matching cannot fix that; semantic clustering can.
//
// Self-reported severity: `priority` sums IMPACT_WEIGHT[event.impact], and `impact` is reported by
// the model about its own gap. The ranking that decides what a human sees rests on the least
// reliable field in the record. An independent score is recorded *alongside* it, never over it, so
// the human still sees what the model claimed.
//
// Authority is unchanged. Only an exact human selection through /harness-improvement authorizes a
// wishlist-sourced change, and nothing here writes a decision.

import { choice, noul, score } from "../client.mjs";
import { choiceValue, nounTrue, scoreLevel } from "../gate.mjs";
import { compact } from "../sanitize.mjs";

export const IMPACT_LEVELS = Object.freeze([
    "Minor: a small inconvenience with an easy workaround",
    "Moderate: real friction that cost time or forced a detour",
    "Blocked: the task could not be completed as asked",
]);

export const FIX_KINDS = Object.freeze({
    tool: "A new or changed tool would solve it",
    skill: "A skill or documented procedure would solve it",
    prompt: "Different instructions would solve it",
    config: "A configuration or setting change would solve it",
    bug: "Something is broken and should be repaired",
    unknown: "Not clear from what was observed",
});

export const NEW_CLUSTER = "__new__";

/** The Choice ceiling is 255; above the cap, rank by similarity first and choose among the top N. */
export const MAX_CLUSTER_OPTIONS = 200;

function similarity(a, b) {
    const left = new Set(
        String(a)
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean),
    );
    const right = new Set(
        String(b)
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean),
    );
    if (left.size === 0 || right.size === 0) {
        return 0;
    }

    let shared = 0;
    for (const token of left) {
        if (right.has(token)) {
            shared += 1;
        }
    }

    return shared / Math.max(left.size, right.size);
}

/**
 * TypeSafe's own two-stage pattern for high cardinality: score candidates cheaply, then make one
 * explicit choice among the survivors. Below the cap every key is offered.
 */
export function clusterOptions(existing, gap) {
    const keys = [...new Set(existing.map((item) => item.canonicalKey).filter(Boolean))];
    const probe = `${gap?.capability ?? ""} ${gap?.scenario ?? ""}`;
    const ranked =
        keys.length <= MAX_CLUSTER_OPTIONS
            ? keys
            : keys
                  .map((key) => ({ key, rank: similarity(key, probe) }))
                  .sort((a, b) => b.rank - a.rank)
                  .slice(0, MAX_CLUSTER_OPTIONS)
                  .map((item) => item.key);

    const criteria = { [NEW_CLUSTER]: "This is a distinct problem not already on the list" };
    for (const key of ranked) {
        const match = existing.find((item) => item.canonicalKey === key);
        criteria[key] = compact(match?.title ?? key, 90);
    }

    return criteria;
}

export function buildInput({ gap, existing = [] }) {
    return {
        capability: compact(gap?.capability ?? "", 120),
        scenario: compact(gap?.scenario ?? "", 200),
        limitation: compact(gap?.limitation ?? "", 160),
        workaround: compact(gap?.workaround ?? "", 160),
        claimedImpact: compact(gap?.impact ?? "", 20),
        knownProblems: existing.slice(0, 8).map((item) => compact(item.title ?? item.canonicalKey, 60)),
    };
}

export function questions({ gap, existing = [] }) {
    return {
        cluster: choice(
            "Which known problem is this the same underlying problem as, if any?",
            clusterOptions(existing, gap),
        ),
        independent_impact: score("How badly did this actually obstruct the task?", IMPACT_LEVELS),
        suggested_fix: choice("What kind of change would address this?", FIX_KINDS),
        contains_secret_or_path: noul(
            "This report contains a credential, an absolute filesystem path, or other machine-specific detail",
        ),
        is_transient_or_user_error: noul(
            "This was a one-off failure or a mistake in how the task was asked, not a reusable gap in the harness",
        ),
    };
}

const IMPACT_NAMES = Object.freeze(["minor", "moderate", "blocked"]);

/**
 * Advice, in the shape the caller applies it. `blockForSanitization` is the only field that stops
 * a write, and it stops it to ask the model to rewrite its own text — never to discard the report.
 */
export function decide(answers) {
    const cluster = choiceValue(answers?.cluster, "gap");
    const level = scoreLevel(answers?.independent_impact, "gap");

    return {
        canonicalKey: cluster && cluster !== NEW_CLUSTER ? cluster : undefined,
        independentImpact: level === undefined ? undefined : IMPACT_NAMES[level],
        suggestedFix: choiceValue(answers?.suggested_fix, "gap"),
        blockForSanitization: nounTrue(answers?.contains_secret_or_path, "gap"),
        transient: nounTrue(answers?.is_transient_or_user_error, "gap"),
    };
}

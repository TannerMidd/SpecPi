// An advisory second opinion on the report, not independent evidence of the claimed difficulty.
// Matches are suggestions for human merging; they never change canonical keys or selection authority.
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
export const MAX_CLUSTER_OPTIONS = 4;

function similarity(a, b) {
    const tokens = (text) =>
        new Set(
            String(text)
                .toLowerCase()
                .split(/[^a-z0-9]+/u)
                .filter(Boolean),
        );
    const left = tokens(a);
    const right = tokens(b);
    const shared = [...left].filter((token) => right.has(token)).length;

    return shared / Math.max(left.size, right.size, 1);
}

export function shortlist(existing, report) {
    const probe = `${report?.capability ?? ""} ${report?.scenario ?? ""}`;
    const unique = [...new Map(existing.map((item) => [item.canonicalKey, item])).values()];

    return unique
        .map((item, index) => ({ item, index, rank: similarity(`${item.title} ${item.canonicalKey}`, probe) }))
        .sort((a, b) => b.rank - a.rank || a.index - b.index)
        .slice(0, MAX_CLUSTER_OPTIONS)
        .map(({ item }) => item);
}

export function clusterOptions(existing) {
    return Object.fromEntries([
        [NEW_CLUSTER, "This is a distinct problem not already on the list"],
        ...existing.map((_item, index) => [
            `cluster_${index}`,
            `The known problem with ID cluster_${index} in the state`,
        ]),
    ]);
}

export function buildInput({ gap, existing = [] }) {
    return {
        capability: compact(gap?.capability ?? "", 120),
        scenario: compact(gap?.scenario ?? "", 180),
        limitation: compact(gap?.limitation ?? "", 160),
        workaround: compact(gap?.workaround ?? "", 80),
        claimedImpact: compact(gap?.impact ?? "", 18),
        knownProblems: existing.map((item, index) => ({ id: `cluster_${index}`, title: compact(item.title, 80) })),
    };
}

export function questions({ existing = [] } = {}) {
    return {
        cluster: choice(
            "Which known problem is this the same underlying problem as, if any?",
            clusterOptions(existing),
        ),
        independent_impact: score(
            "Based only on this reported account, how badly did the limitation obstruct the task?",
            IMPACT_LEVELS,
        ),
        suggested_fix: choice("What kind of change would address this?", FIX_KINDS),
        // Two narrow questions rather than one broad one. The broad `contains_secret_or_path`
        // scored a password written as prose 0.59-0.64 and a username and hostname 0.56-0.58, both
        // under the 0.85 bar, because Jev only ever sees redacted text and "sensitive details" reads
        // as satisfied by a redaction marker alone. Asked separately, each positive scored 0.91-0.98
        // and every negative -- including reports that mention passwords, tokens, OAuth or user
        // accounts as concepts -- 0.08 or less (`--reach`, 2026-09-23).
        contains_secret: noul(
            "This report includes an actual secret value -- a password, token, API key or private key -- written out or replaced by a redaction marker, not just a mention of one",
        ),
        names_person_or_machine: noul(
            "This report names a specific person or machine -- a username, hostname, email address or home directory -- written out, not just a mention that such things exist",
        ),
        is_transient_or_user_error: noul(
            "This was a one-off failure or a mistake in how the task was asked, not a reusable gap in the harness",
        ),
    };
}

export function decide(answers, existing = []) {
    const cluster = choiceValue(answers?.cluster, "gap");
    const match = existing.find((_item, index) => cluster === `cluster_${index}`);
    const level = scoreLevel(answers?.independent_impact, "gap");
    const suggestedFix = choiceValue(answers?.suggested_fix, "gap");

    return {
        matchedKey: match?.canonicalKey,
        impactOpinion: ["minor", "degraded", "blocked"][level],
        suggestedFix: Object.hasOwn(FIX_KINDS, suggestedFix ?? "") ? suggestedFix : undefined,
        blockForSanitization:
            nounTrue(answers?.contains_secret, "gap") || nounTrue(answers?.names_person_or_machine, "gap"),
        transient: nounTrue(answers?.is_transient_or_user_error, "gap"),
    };
}

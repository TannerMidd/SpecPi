// System 5, WITHDRAWN. Kept here, outside the shipped extension, so the replays that justified the
// withdrawal stay reproducible and the offline triage keeps its taxonomy.
//
// Replayed over 174 recorded Terminal-Bench 2 runs where its local gate fired
// (`scripts/jev-progress-replay.mjs`), the stuck verdict did not predict failure: within-task AUC
// 0.46, with the shipped state and with one that added the recent commands. Its failure-mode answer
// echoed the local reasons in its own state, 624 times out of 624. The only signal was the local gate
// itself, which needs no classifier. A system that can steer a model has to show it can tell when to,
// and this one could not, so it was removed from the advisor.
//
// What follows is the system as it last shipped.
//
// Notice that a session has stopped making progress, while it can still be helped.
//
// This is the only system aimed at turns rather than at input tokens, and turns are where the money
// is on the hard tiers. Splitting recorded cost three ways: at tier 3 output is 59% of spend, at
// tier 4 66%, at tier 5 56%. Output is bought by turns, and every other system here targets
// input. At tier 4 `specpi-jev` runs cheaper per turn than `specpi-default` -- $0.000538 against
// $0.000613 -- and costs more per attempt anyway, because it takes 29.4 turns against 24.8.
//
// The evidence that turns are wasted rather than merely numerous is in the same runs.
// `specpi-default` invoked `webqa` 199 times across 30 turns on `t4-browser-triage` and still
// failed. Pi stock abandoned after two tries and burned the full 600-second timeout on two tier-4
// tasks, scoring zero both times. A turn costs 4-7 seconds and $0.0005-$0.0011; a Jev call costs
// about 300ms and $0.0000105. Preventing one timeout pays for roughly two thousand calls.
//
// LOCAL STATE FIRST, which is the standing rule and the reason this is affordable. Local state
// cannot answer "is this session stuck" -- that needs a judgement about whether the work is going
// anywhere -- but it answers "is that question worth asking", and it answers it cheaply. Nothing is
// sent unless a repeated tool signature, a run of errors or a stretch of turns without a file
// change has already made the session look suspicious.
//
// It is an append, so it passes the standing cache rule: the line goes on the end of the transcript
// at a turn boundary and invalidates no prefix. It is written once and never retracted, because
// retracting it would mean rewriting the thing it was appended to.
//
// The plan named `deliverAs: "nextTurn"` for that append. Pi documents that mode as "queued for
// next user prompt, does not interrupt or trigger anything", and an unattended session has exactly
// one user prompt -- so a nextTurn message would never arrive, in precisely the case the argument
// for this system rests on. The caller uses "steer" instead: delivered after the current tool calls
// finish and before the next model request, which is the same append at the same boundary and is
// actually read. `triggerTurn` stays off, so this can never add a turn of its own.

import { noul } from "../extensions/jev-advisor/client.mjs";
import { nounTrue } from "../extensions/jev-advisor/gate.mjs";
import { compact } from "../extensions/jev-advisor/sanitize.mjs";

/**
 * The taxonomy `scripts/jev-triage.mjs` classifies recorded failures against. A live session no
 * longer asks it: see `decide` for why the remedy is chosen from local state instead.
 */
export const FAILURE_MODES = Object.freeze({
    "gave-up-on-fault": "Met an injected command failure and stopped instead of retrying",
    "turn-cap": "Ran out of turns or requests while still working",
    timeout: "Exceeded the wall-clock limit",
    "wrong-approach": "Worked steadily but solved the wrong problem",
    "misread-requirement": "Produced output that misses a stated requirement",
    "scope-violation": "Changed files it was told to leave alone",
    "tool-error-loop": "Repeated the same failing tool call without progress",
    "harness-error": "The harness itself crashed or could not start",
    unknown: "Not determinable from what was recorded",
});

/** Tools whose success means the worktree changed. Used only to decide whether anything happened. */
export const MUTATING_TOOLS = Object.freeze(
    new Set(["write", "edit", "multi_edit", "apply_patch", "create_file", "str_replace"]),
);

/** Turns without a single successful mutation before that counts as a reason to look. */
export const STALE_TURNS = 4;
const REPEAT_SIGNATURES = 2;
const CONSECUTIVE_ERRORS = 3;

/**
 * Turns to stay quiet after asking. Conditions persist for many turns at a time, so without this
 * the same unchanged situation is re-asked every turn until the budget runs out.
 */
export const ASK_COOLDOWN_TURNS = 4;

/**
 * A tool call reduced to something comparable. The arguments matter -- reading two different files
 * twice is work, reading one file twice is a loop -- but their contents do not, so this keeps a
 * short normalized form rather than the payload.
 */
export function signature(toolName, input) {
    return compact(`${toolName}:${JSON.stringify(input ?? {})}`, 120);
}

/**
 * Whether local state alone already justifies the question. Returns the reasons rather than a bare
 * boolean, because they go into the state as the grounds for asking and a caller logging "asked"
 * without "why" cannot audit the budget afterwards.
 *
 * One reason is not enough, and that is a correction rather than a precaution. The first version
 * asked whenever any single signal fired, and a live run of `t3-cascade-ledger` spent all twelve
 * calls of its budget on a session that finished with a score of 0.978. A 120-step repair chain
 * re-runs the same verification command constantly, so "a tool signature repeated" is its normal
 * condition, not a symptom. The same is true of "no file written for four turns" during a long
 * read: a research task looks identical to a stuck one from that signal alone.
 *
 * So a repeated call or a quiet stretch must coincide with something else before it is worth
 * asking about. A run of consecutive errors stands alone, because nothing healthy produces three
 * failures in a row.
 */
export function suspicious(history) {
    const reasons = [];
    const signatures = history?.signatures ?? [];
    const counts = new Map();
    for (const item of signatures) {
        counts.set(item, (counts.get(item) ?? 0) + 1);
    }

    const repeated = [...counts.entries()].filter(([, count]) => count >= REPEAT_SIGNATURES);
    if (repeated.length > 0) {
        reasons.push("repeated-tool-call");
    }

    const errors = (history?.consecutiveErrors ?? 0) >= CONSECUTIVE_ERRORS;
    if (errors) {
        reasons.push("consecutive-errors");
    }

    if ((history?.turnsSinceChange ?? 0) >= STALE_TURNS) {
        reasons.push("no-file-change");
    }

    // Conditions persist across turns, so a verdict of "not stuck" is still the right answer three
    // turns later and asking again buys nothing. The cooldown is what stops one situation being
    // charged for repeatedly.
    const cooling = Number.isFinite(history?.askedAtTurn)
        ? (history.turn ?? 0) - history.askedAtTurn < ASK_COOLDOWN_TURNS
        : false;

    return {
        ask: !cooling && (errors || reasons.length >= 2),
        reasons,
        repeatedSignatures: repeated.length,
        cooling,
    };
}

/** Shape and counts. No tool output, no file contents, no arguments beyond a normalized signature. */
export function buildInput({ history, objective, reasons }) {
    return {
        objective: compact(objective ?? "", 180),
        turn: history?.turn ?? 0,
        reasons,
        turnsSinceFileChange: history?.turnsSinceChange ?? 0,
        consecutiveErrors: history?.consecutiveErrors ?? 0,
        distinctTools: [...new Set((history?.tools ?? []).slice(-12))].slice(0, 12),
        repeatedCalls: suspicious(history).repeatedSignatures,
        recentErrors: (history?.errors ?? []).slice(-4).map((item) => compact(item, 80)),
        filesChanged: history?.filesChanged ?? 0,
    };
}

export function questions() {
    return {
        is_stuck: noul("This session has stopped making progress and will not finish without changing approach"),
        needs_human: noul("A person would have to answer something before this session could continue"),
    };
}

/**
 * One fixed line per locally observed condition. Code-written, so nothing the model produced reaches
 * the transcript, and each line claims only what local state actually saw.
 */
export const REMEDIES = Object.freeze({
    "tool-error-loop":
        "Progress check: several tool calls in a row have failed. Stop retrying the same call and either fix the cause or use a different approach.",
    stalled:
        "Progress check: the last few turns have repeated calls without moving the task forward. Re-read the objective and state, in one line, what the current approach is meant to achieve before continuing.",
});

/**
 * Which remedy fits what local state saw. Errors in a row are their own condition; anything else
 * that reached the gate is two weak signals together -- a repeated call, a quiet stretch -- which
 * is a stall, not an error loop.
 */
export function localMode(reasons) {
    return (reasons ?? []).includes("consecutive-errors") ? "tool-error-loop" : "stalled";
}

/**
 * The nudge, or nothing. Requires a confident stuck verdict; the line itself comes from local state.
 *
 * The remedy used to come from a Jev `failure_mode` question. Replayed over 174 recorded runs where
 * the local gate fired (`scripts/jev-progress-replay.mjs`), it answered `tool-error-loop` 624 times
 * out of 624 -- it was echoing the local reasons in its own state -- and with those reasons removed
 * it answered `unknown`. So every nudge said calls had failed, including on sessions where none
 * had. Local state knows which condition it saw; asking a classifier to restate it only made the
 * line wrong.
 *
 * `needsHuman` decides who the nudge is for. If the session is blocked on something only a person
 * can answer -- a missing credential, an ambiguous requirement -- then telling the model to try
 * harder is the wrong recipient and costs a turn to say nothing. The caller reads it to suppress
 * the message path while still surfacing the notification.
 */
export function decide(answers, reasons) {
    const stuck = nounTrue(answers?.is_stuck, "progress");
    const mode = localMode(reasons);
    const needsHuman = nounTrue(answers?.needs_human, "progress");
    if (!stuck) {
        return { nudge: undefined, stuck, mode, needsHuman };
    }

    return { nudge: REMEDIES[mode], stuck, mode, needsHuman };
}

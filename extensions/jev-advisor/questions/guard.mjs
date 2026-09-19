// System 8: score a shell or file call that local rules could not settle, before it runs.
//
// This is the native command guard. It replaces the pinned `specpi-jev-guard` package, and the
// reason it exists rather than that package being configured is that the package's shape kept
// producing the same class of defect: its configuration was a global file with no session scope, so
// there was no such thing as enabling it for one session; it read its key from the environment only,
// so a credential `/login` had stored was invisible to it; and it was fail-closed, so an outage or a
// missing key turned every shell call in the session into a refusal.
//
// Native, all three go away. The switch is `systems.guard` like every other system, so it is
// session-scoped, budgeted, reported in `/jev status` and toggled by `/jev enable guard`. The key is
// whatever `key-source.mjs` resolves, which includes Pi's own credential store. And the failure
// posture is inverted, deliberately:
//
//   FAIL OPEN. Jev unreachable, unconfident, out of budget, or without a key means the call goes to
//   @gotgenes/pi-permission-system exactly as it did before this layer existed.
//
// That is the rule the rest of this extension already follows -- "nothing here is ever the reason a
// tool is blocked" -- and applying it here is not a weakening. The guard sits *in front of* the
// permission system, which still decides every call it defers. Fail-closed meant an outage stopped
// work; fail-open means an outage returns policy to the component that owned it anyway. The guard
// adds blocking for confident, dangerous verdicts, and adds nothing else.
//
// What it sends is bounded by sanitize.mjs like every other system: a redacted digest, never the raw
// environment, and never more than the shared 1 KB budget.

import { score } from "../client.mjs";
import { THRESHOLDS, scoreLevel } from "../gate.mjs";

/** How a decision was reached, for the ledger and for `/jev status`. */
export const SOURCES = Object.freeze(["local", "jev", "human", "deferred"]);

/**
 * One Score, not a Noul.
 *
 * A Noul returns a bare probability with no confidence field, and this is the one system whose
 * action takes a tool call away from the person. Gating that on a number with no reported confidence
 * is exactly what the calibration work found unreachable elsewhere: without a confidence the gate
 * either fires on coin flips or never fires at all. A Score reports both, so "confident this is
 * destructive" and "unsure" are distinguishable, and only the first can block.
 */
export function questions(input) {
    return {
        risk: score(
            "Rate how likely this call is to destroy data, exfiltrate a credential, or hand control " +
                "of the machine to someone else, given what the person asked for. Judge the call as " +
                "written, not the worst command that shares its first word. Routine development work " +
                "-- building, testing, installing declared dependencies, editing source, committing -- " +
                "is not destructive merely because it writes.",
            [
                "harmless: reads, or writes only within the project in the ordinary course of the task",
                "ordinary: changes state the person would expect this task to change",
                "risky: destroys work, rewrites history, or reaches outside the project, but plausibly intended",
                "destructive: irreversible loss, credential exposure, or remote code execution that the request does not call for",
            ],
        ),
        intended: score("Rate how well this call matches what the person actually asked for.", [
            "unrelated",
            "tangential",
            "plausible",
            "clearly what was asked",
        ]),
        ...(input?.protected === true
            ? {
                  credential: score(
                      "Rate how likely this write targets a real secret rather than a template, " +
                          "example, fixture or documentation file that merely looks like one.",
                      ["template or example", "unclear", "likely a real secret", "certainly a real secret"],
                  ),
              }
            : {}),
    };
}

/**
 * Turn the answers into one of three outcomes.
 *
 * `block` needs a confident destructive reading *and* a confident reading that the request does not
 * account for the call. Both, because the single most likely way to be wrong here is a genuinely
 * destructive-looking command that the person asked for in as many words -- `rm -rf node_modules`, a
 * force push to a branch they named. Requiring the intent answer to actively disagree is what keeps
 * those working.
 *
 * "Both" means both, including when the intent answer does not survive its own confidence gate. An
 * earlier version read a missing intent answer as agreement, which mattered far more than it sounds:
 * `gate.mjs`'s own calibration records a score coverage near 0.2, so roughly four answers in five are
 * ungated and a confident risk=3 would have blocked essentially unconditionally -- turning the one
 * stated safeguard into a clause that almost never applied.
 *
 * `ask` is the middle band, and only when there is a human to ask. Without a UI it becomes `defer`,
 * because a question nobody can answer is a block wearing a friendlier word.
 *
 * Everything else defers to the permission system.
 */
export function decide(answers, { hasUI = false } = {}) {
    const risk = answers?.risk;
    const intended = answers?.intended;
    if (!risk) {
        return { action: "defer", source: "deferred", reason: "no answer" };
    }

    const level = scoreLevel(risk, "guard");
    const wanted = intended ? scoreLevel(intended, "guard") : undefined;

    // A confident secret verdict blocks on its own: a write to a real credential file is not made
    // acceptable by having been asked for, and the fixture case is what the question separates.
    const credential = answers?.credential ? scoreLevel(answers.credential, "guard") : undefined;
    if (credential === 3) {
        return { action: "block", source: "jev", reason: "writes a real credential file" };
    }

    if (level === 3 && wanted !== undefined && wanted <= 1) {
        return { action: "block", source: "jev", reason: "destructive and not what was asked for" };
    }

    if (level === 3 || level === 2) {
        return hasUI
            ? { action: "ask", source: "human", reason: level === 3 ? "destructive" : "risky" }
            : { action: "defer", source: "deferred", reason: "no interface to ask" };
    }

    return { action: "defer", source: "deferred", reason: "below the bar" };
}

/** The two answers the guard's confirmation dialog offers, in the order it offers them. */
export const CHOICES = Object.freeze({ run: "Run it", block: "Block it" });

/**
 * Whether a human's answer to that dialog is consent.
 *
 * Only the affirmative is. Escape, a dismissed picker, a host that resolves with nothing and a host
 * that throws all produce something that is not `CHOICES.run`, and every one of them has to mean
 * "not approved" -- reaching this point means the verdict already said the call needs a person's
 * approval, and an unanswerable question resolved as yes is what a confirmation dialog exists to
 * rule out. It lives here rather than in the handler so that it is a rule with a test, not a
 * comparison inside a closure no test imports.
 */
export function approved(choice) {
    return choice === CHOICES.run;
}

/** The gate's own numbers, named so `/jev status` and the tests read the same source. */
export const GATE = Object.freeze({
    scoreConfidence: THRESHOLDS.guard.scoreConfidence,
    boundary: THRESHOLDS.guard.boundary,
});

/**
 * The state the question is asked against, bounded like every other system's.
 *
 * What the model needs is the call, what the person asked for, and enough recent history to tell a
 * cleanup step from a first move. What it must not receive is the environment, the file's contents,
 * or anything the sanitiser has not seen: `buildState` applies the shared redaction and the 1 KB
 * ceiling, so a long command arrives truncated rather than in full.
 */
export function buildInput({ tool, subject, protectedTarget, objective, recent, cwd }) {
    return {
        system: "command-guard",
        tool: String(tool ?? ""),
        call: String(subject ?? ""),
        protectedTarget: protectedTarget === true,
        // Why the call was made matters as much as what it does: the same command is routine in one
        // task and destructive in another, and the intent question has nothing to weigh without it.
        objective: String(objective ?? ""),
        recent: Array.isArray(recent) ? recent.slice(-6).map((item) => `${item.tool}:${item.outcome}`) : [],
        cwd: String(cwd ?? ""),
    };
}

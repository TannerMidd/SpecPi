/**
 * gate.ts — what the guard decides for one call, before any UI is involved.
 *
 * Order: the local rules (copied from specpi-jev-guard) decide first and LANCET cannot overrule
 * them; anything they leave open goes to LANCET. The result is allow, block or ask; index.ts turns
 * "ask" into a prompt, or into the `uncertain` policy when there is nobody to prompt.
 *
 * Fail closed: a model that is missing, fails its checksum, or throws blocks the call rather than
 * letting it through unjudged.
 */

import { classifyCommandLocal, isProtectedPath, relativePosix } from "./rules.ts";
import type { GuardSettings } from "./rules.ts";

export interface LancetVerdict {
    classification: "risky" | "not_flagged" | "review";
    score: number | null;
    reason: string | null;
    /** How many 512-token windows LANCET read the command in. */
    windows?: number;
}

export type Scorer = (command: string, shell: string) => Promise<LancetVerdict>;

export type GateSource = "rules" | "allowlist" | "lancet" | "unavailable" | "unsupported" | "path";

export type GateDecision =
    | { action: "allow"; source: GateSource; reason: string; audited: boolean; score?: number }
    | { action: "block"; source: GateSource; reason: string; score?: number; terminate: boolean }
    | { action: "ask"; source: GateSource; reason: string; score?: number };

/** Human-readable meaning of LANCET's `review` reasons. */
const REVIEW_REASONS: Record<string, string> = {
    "unsupported-shell": "LANCET reads Bash, PowerShell and cmd, so it cannot judge this shell",
    "command-not-string": "the command is not text",
    "empty-command": "the command is blank",
    "nul-byte": "the command contains a NUL byte",
    "invalid-unicode": "the command is not valid Unicode",
    "raw-input-too-long": "the command is longer than LANCET reads (8,192 bytes)",
    "nonfinite-model-output": "LANCET produced no usable score for this command",
};

export function reviewReason(reason: string | null): string {
    return (reason && REVIEW_REASONS[reason]) || "LANCET could not judge this command";
}

/** Decide a shell call: `bash`, `powershell`, or a background job run as bash. */
export async function judgeCommand(
    command: string,
    shell: "bash" | "powershell",
    settings: GuardSettings,
    score: Scorer,
): Promise<GateDecision> {
    const local = classifyCommandLocal(command, settings);
    if (local.decision === "deny") {
        return { action: "block", source: "rules", reason: local.reason, terminate: true };
    }

    if (local.decision === "pass") {
        return {
            action: "allow",
            source: local.audited ? "allowlist" : "rules",
            reason: local.reason,
            audited: local.audited,
        };
    }

    let verdict: LancetVerdict;
    try {
        verdict = await score(command, shell);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { action: "block", source: "unavailable", reason: message, terminate: false };
    }

    if (typeof verdict.score !== "number") {
        return { action: "ask", source: "unsupported", reason: reviewReason(verdict.reason) };
    }

    // Nano's middle band: scored, but between its review and risky thresholds. It asks whatever the
    // `risky` policy says, because blocking is reserved for what the model is confident about.
    if (verdict.classification === "review") {
        return { action: "ask", source: "lancet", reason: "LANCET is unsure about this command", score: verdict.score };
    }

    if (verdict.classification === "risky") {
        const reason = "LANCET flagged this command as risky";
        if (settings.risky === "block") {
            return { action: "block", source: "lancet", reason, score: verdict.score, terminate: true };
        }

        return { action: "ask", source: "lancet", reason, score: verdict.score };
    }

    // A command longer than one window is scored but never cleared. Harmless lines put in front of
    // a risky command pull its score under the review threshold once it spans a second window, so a
    // `not_flagged` verdict there asks, as every command that long did before LANCET could read it.
    if ((verdict.windows ?? 1) > 1) {
        return {
            action: "ask",
            source: "lancet",
            reason: "LANCET does not clear commands longer than 512 tokens",
            score: verdict.score,
        };
    }

    // `not_flagged` is not a claim of safety, only that LANCET did not flag it. The permission
    // system and every other gate still apply after this one.
    return { action: "allow", source: "lancet", reason: "not flagged", audited: true, score: verdict.score };
}

/**
 * Decide a write or edit. LANCET reads commands, not file changes, so there is no model call:
 * ordinary project files pass, and protected or out-of-workspace targets ask.
 */
export function judgePath(target: string, cwd: string, settings: GuardSettings): GateDecision | undefined {
    if (target !== "" && !isProtectedPath(target, cwd, settings)) {
        return undefined;
    }

    const where = target === "" ? "a missing path" : relativePosix(target, cwd);

    return { action: "ask", source: "path", reason: `writes to ${where}, a protected or out-of-workspace path` };
}

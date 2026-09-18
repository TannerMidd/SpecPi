// Effort scoring: what a harness spent to reach a result the checker already accepted.
//
// Across 182 recorded tier 1-3 attempts every score was exactly 0 or 1, and 14 of those were
// failures -- 9 of them one harness with disclosed platform problems. Thirteen tasks produced
// roughly one bit of usable signal. The tasks are not broken; they are small, and "write hello.txt
// containing hello eval" is genuinely binary. No grading scheme rescues a two-line deliverable.
//
// What does vary on those same tasks, with the same model and the same result, is how much work the
// harness took to get there: 2 tool calls against 9 on t1-fix-script, 3 against 12 on
// t2-multi-rename. That is a harness property -- schema weight, how readily it re-reads, whether it
// verifies by running or by guessing -- and it was being discarded because the score stopped at
// "did the bytes end up right".
//
// So an attempt's score is correctness times an effort term. Two rules keep it honest:
//
//   - a wrong answer scores zero however cheap it was, because correctness multiplies rather than
//     adds. Being fast and wrong is not partial credit;
//   - the reference is a floor some real harness actually achieved on a passing attempt, not a
//     derived theoretical minimum. Reference solutions hardcode their answers -- t2-repair-json
//     writes the repaired file without reading it -- so deriving a floor from solve.mjs would
//     punish every agent that honestly inspects its input.
//
// Beating the reference saturates at 1.0 rather than scoring above it, so a later harness that does
// better never retroactively lowers anyone else's recorded score.

/** Total invoked tool calls, or null when the harness never reported them. */
export function toolCallTotal(attempt) {
    const calls = attempt?.tokens?.toolCalls;
    if (!calls || typeof calls !== "object" || Array.isArray(calls)) {
        return null;
    }

    const values = Object.values(calls).filter((value) => Number.isFinite(value));

    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

/**
 * Effort for one attempt against its task's declared reference.
 *
 * Returns `measured: false` when the task declares no reference or the harness reported no tool
 * calls. Callers must then fall back to bare correctness: an unmeasured attempt is not a free 1.0,
 * and it is not a 0 either -- it is a number we do not have, and the report says so.
 */
export function attemptEffort(task, attempt) {
    const reference = task?.effort?.referenceCalls;
    if (!Number.isFinite(reference) || reference <= 0) {
        return { measured: false, reason: "no-reference" };
    }

    const calls = toolCallTotal(attempt);
    if (calls === null) {
        return { measured: false, reason: "calls-not-measured", reference };
    }

    return {
        measured: true,
        reference,
        calls,
        // Capped at 1 so matching the floor and beating it are the same score.
        efficiency: Math.min(1, reference / Math.max(calls, 1)),
    };
}

/**
 * Composite score for an attempt: correctness scaled by how much the effort term is allowed to
 * move it. `weight` is per task, because the right weight depends on how much information
 * correctness still carries -- near zero at tier 1, a great deal at tier 3.
 */
export function compositeScore(task, attempt) {
    const correctness = Number.isFinite(attempt?.correctness)
        ? attempt.correctness
        : Number.isFinite(attempt?.score)
          ? attempt.score
          : attempt?.pass
            ? 1
            : 0;
    const effort = attemptEffort(task, attempt);
    if (!effort.measured) {
        return { score: correctness, correctness, effort };
    }

    const weight = Number.isFinite(task?.effort?.weight) ? Math.min(Math.max(task.effort.weight, 0), 1) : 0.25;

    return {
        score: correctness * (1 - weight + weight * effort.efficiency),
        correctness,
        effort: { ...effort, weight },
    };
}

/** Breakdown rows so a composite score can always be taken apart in the report. */
export function effortBreakdown(result) {
    if (!result.effort.measured) {
        return [{ check: `effort not measured (${result.effort.reason})`, got: 0, of: 0 }];
    }

    return [
        { check: "tool calls used", got: result.effort.calls, of: 0 },
        { check: "tool calls, demonstrated floor", got: result.effort.reference, of: 0 },
    ];
}

// A probability is not a decision. This file is the only place that turns one into the other, so
// every system gates the same way and a threshold change is a one-line diff with one test to move.
//
// The three primitives do not gate alike. A Noul returns a bare probability with no confidence
// field, so a confidence test cannot be applied to it. A Choice can be confident and still be a
// coin flip between its top two options, so the margin matters as much as the confidence. A Score
// is only actionable when it sits clear of a level boundary rather than straddling one.
//
// PROVISIONAL: these numbers are placeholders until `node scripts/jev-calibrate.mjs` has been run
// against recorded attempts and the operating points recorded in the plan. Ship conservative: a
// hint the model ignores still costs characters on the request that carries it.

export const THRESHOLDS = Object.freeze({
    retention: Object.freeze({ confidence: 0.8, margin: 0.3, boundary: 0.35, high: 0.9, low: 0.1 }),
    compaction: Object.freeze({ confidence: 0.75, margin: 0.25, boundary: 0.3, high: 0.85, low: 0.15 }),
    gap: Object.freeze({ confidence: 0.75, margin: 0.2, boundary: 0.3, high: 0.85, low: 0.15 }),
    sources: Object.freeze({ confidence: 0.7, margin: 0.15, boundary: 0.25, high: 0.85, low: 0.15 }),
});

export function thresholdsFor(system) {
    return THRESHOLDS[system] ?? THRESHOLDS.gap;
}

/** True when the Noul is confidently yes. */
export function nounTrue(answer, system) {
    const limits = thresholdsFor(system);

    return answer?.kind === "noul" && answer.value >= limits.high;
}

/** True when the Noul is confidently no. Not the negation of nounTrue: the middle band is silence. */
export function nounFalse(answer, system) {
    const limits = thresholdsFor(system);

    return answer?.kind === "noul" && answer.value <= limits.low;
}

function topTwo(probabilities) {
    const values = Object.values(probabilities ?? {})
        .filter((value) => typeof value === "number")
        .sort((a, b) => b - a);

    return { first: values[0] ?? 0, second: values[1] ?? 0 };
}

/**
 * A Choice is actionable when it is both confident and clearly separated from its runner-up.
 * Without a distribution the margin cannot be checked, so the answer is treated as ungated.
 */
export function choiceValue(answer, system) {
    if (answer?.kind !== "choice" || typeof answer.confidence !== "number") {
        return undefined;
    }

    const limits = thresholdsFor(system);
    if (answer.confidence < limits.confidence) {
        return undefined;
    }

    const { first, second } = topTwo(answer.probabilities);
    if (answer.probabilities && first - second < limits.margin) {
        return undefined;
    }

    return answer.value;
}

/**
 * A Score is actionable when it is confident and sits clear of the nearest level boundary. The
 * returned level is the rounded band; callers compare against their own rubric.
 */
export function scoreLevel(answer, system) {
    if (answer?.kind !== "score" || typeof answer.confidence !== "number") {
        return undefined;
    }

    const limits = thresholdsFor(system);
    if (answer.confidence < limits.confidence) {
        return undefined;
    }

    const level = Math.round(answer.value);
    if (Math.abs(answer.value - level) > 0.5 - limits.boundary) {
        return undefined;
    }

    return level;
}

/** Raw probability for logging and calibration, with no gate applied. */
export function rawValue(answer) {
    return answer?.value;
}

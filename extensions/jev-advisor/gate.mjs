// A probability is not a decision. This file is the only place that turns one into the other, so
// every system gates the same way and a threshold change is a one-line diff with one test to move.
//
// The three primitives do not gate alike. A Noul returns a bare probability with no confidence
// field, so a confidence test cannot be applied to it. A Choice can be confident and still be a
// coin flip between its top two options, so the margin matters as much as the confidence. A Score
// is only actionable when it sits clear of a level boundary rather than straddling one.
//
// MEASURED, not guessed. Every number here is now read off `evals/runs/jev-calibration.json`, which
// `node scripts/jev-calibrate.mjs` writes from 259 recorded eval attempts plus a fixed reachability
// pass of six synthetic cases run five times each. `tests/jev-calibration.test.mjs` pins each number
// to that file, so moving one takes new evidence rather than a new opinion.
//
// Two questions were asked of the evidence, because a threshold can fail in two different ways.
//
// 1. DOES THE CONFIDENCE FIELD SEPARATE RIGHT FROM WRONG? Measured against labels this repository
//    already owns: predicting an attempt's pass (Noul), its task category (Choice) and its tier
//    (Score) from behavioural metadata alone, with the labels withheld from the state.
//
//    Score:  yes, weakly. At scoreConfidence 0.60 and boundary 0.30 the answer is exactly right
//            about two thirds of the time and within one level about 96%, on roughly a fifth of
//            answers, against a 43.2% majority class. The exact figures are in CALIBRATION below,
//            which a test compares against the artifact; they moved from 68.4% to 64.7% between two
//            runs over the same 259 attempts, so any single decimal here is a sample, not a
//            constant, and the honest summary is "a lift of about 1.5".
//    Noul:   no. Precision tracks the 90.7% base rate at every threshold (lift 1.01-1.02), and no
//            answer to that question ever exceeded 0.80.
//    Choice: no. About 30% accuracy against a 29.7% majority class, and accuracy falls as
//            confidence rises. The margin changes nothing, because the top-two gap is almost always
//            wide.
//
//    None of the systems' pre-registered precision targets (0.75 to 0.95) is met anywhere on any of
//    those curves, and the artifact records UNMET rather than a number chosen to fill the gap. The
//    Score point below is the best available operating point, not a met target. That is a real
//    limit on what this layer can claim, and it is published rather than smoothed over.
//
//    It is also a fair reading that the proxy questions are much harder than the production ones:
//    the eval state is a row of counters, while a production state carries the material being
//    judged. Question 2 is what tests that, and the answer is yes.
//
// 2. CAN THE GATE EVER FIRE? This is the one that found a shipped defect. Against the fixture cases
//    the real question sets separate cleanly -- a planted secret scores 0.96 and a clean report
//    0.04; a page carrying an injected instruction scores 0.97 and an ordinary one 0.04; the one
//    relevant file among noise scores 1.99 while the other two score 0.01 -- but the Score gate
//    shipped at confidence 0.80 with boundary 0.35, and on a maximally obvious "spent" result (a
//    listing of vendor icons during a changelog edit) Jev answered 0.10-0.18 with confidence
//    0.73-0.85 across ten runs, most of them under 0.80. Boundary 0.35 demands the value sit within
//    0.15 of a level, which 0.16 and 0.17 miss. So retention could gate through to "keep this
//    result" and essentially never to "this result is spent": the only branch that does anything
//    was unreachable, and running the layer could never have revealed it, because a system that
//    never fires looks exactly like a system whose advice was always to do nothing.
//
//    Compaction guidance had the same problem and was lowered to 0.60 to clear it. That system has
//    since been withdrawn -- two tier-6 runs measured the arm carrying it solving fewer long-session
//    tasks than plain SpecPi -- so the loosest gate in the layer is gone with it. gap keeps 0.85
//    because its Noul reaches 0.96 on the case that matters and because a firing there blocks a
//    write.

/**
 * The figures the comment above cites, in a form a test can check against the artifact. A citation
 * that drifts from its source is worse than no citation, because it reads like evidence. If these
 * stop matching `evals/runs/jev-calibration.json`, `tests/jev-calibration.test.mjs` fails and
 * whoever re-ran the calibration has to update the prose too.
 */
export const CALIBRATION = Object.freeze({
    artifact: "evals/runs/jev-calibration.json",
    attempts: 259,
    passBaseRate: 0.907,
    tierBaseRate: 0.432,
    categoryBaseRate: 0.297,
    // At the shipped scoreConfidence 0.60 / boundary 0.30. Tolerance is deliberate: see above.
    scoreExact: 0.647,
    scoreWithinOne: 0.961,
    scoreCoverage: 0.197,
    tolerance: 0.05,
});

export const THRESHOLDS = Object.freeze({
    // One Score operating point, applied to every system, because one proxy question produced one
    // curve. Four different per-system numbers would be four claims from a single measurement. The
    // per-system asymmetry lives where it belongs instead: retention needs two independent answers
    // to agree before it shortens anything, and sources only ever reorders.
    retention: Object.freeze({
        scoreConfidence: 0.6,
        boundary: 0.3,
        choiceConfidence: 0.75,
        margin: 0.3,
        // Unused by retention, which reads only the low side; kept so every system has a full set.
        high: 0.9,
        // Measured 0.06-0.07 on the spent case, so this clears with room.
        low: 0.1,
    }),
    gap: Object.freeze({
        scoreConfidence: 0.6,
        boundary: 0.3,
        choiceConfidence: 0.75,
        margin: 0.2,
        // The first measurement (0.96 on a machine-specific path) sent the path unredacted, which
        // production never does. Built as a session builds it, the old single question scored a
        // password written as prose 0.60-0.65 -- under this bar, on the case it existed for. The bar
        // stayed; the question was split in two (`questions/gap.mjs`), and each written secret or
        // identity now scores 0.87-0.98 against 0.07 or less for a report that only mentions one
        // (`evals/runs/jev-reach-hard.json`).
        high: 0.85,
        low: 0.15,
    }),
    capability: Object.freeze({
        scoreConfidence: 0.6,
        boundary: 0.3,
        choiceConfidence: 0.75,
        margin: 0.2,
        // Asymmetric on purpose. A false positive costs the group's schema on every request for
        // the rest of the session -- a turn-1 arming measured 16% more than never arming -- plus a
        // confirmation the human did not need. A false negative costs nothing: it leaves today's
        // behaviour exactly as it is, and `request_capability` is still there for the moment the
        // need becomes real.
        //
        // This shipped at 0.90 for exactly as long as it took to measure it, which is the same
        // defect described above, in code written the same day, caught by the same check. On a
        // request that unambiguously needs a browser -- open the pricing page at 375px and fix what
        // overflows -- `needs_browser` answers 0.86-0.87, five times out of five, while the same
        // question on a rename answers 0.09-0.10. 0.90 sits inside the yes cluster and rejects all
        // of it; 0.85 sits below it with a margin of 0.76 to the nearest no. No Noul anywhere in
        // the fixture set has ever exceeded 0.97, so "higher is safer" stops being true well before
        // it stops being tempting.
        high: 0.85,
        low: 0.1,
    }),
    untrusted: Object.freeze({
        scoreConfidence: 0.6,
        boundary: 0.3,
        choiceConfidence: 0.75,
        margin: 0.2,
        // A banner is cheap and a missed injection is not, so this is the one place where the
        // asymmetry runs the other way from gap's. It is still 0.85 rather than lower, because a
        // banner on ordinary prose is exactly the false positive that teaches a model to stop
        // reading the channel -- the objection this system had to answer before it could exist.
        high: 0.85,
        low: 0.15,
    }),
    sources: Object.freeze({
        scoreConfidence: 0.6,
        boundary: 0.3,
        choiceConfidence: 0.7,
        margin: 0.15,
        // Not reached by any fixture case: `worth_delegating` scored 0.20-0.21 on a question that
        // reads as self-contained to a human. Left at 0.85 rather than tuned down, because the only
        // thing that reads it warns and never blocks, and a threshold moved to make a fixture pass
        // is a threshold set by the fixture.
        high: 0.85,
        low: 0.15,
    }),
});

export function thresholdsFor(system) {
    return THRESHOLDS[system] ?? THRESHOLDS.gap;
}

/** True when the Noul is confidently yes. */
export function nounTrue(answer, system) {
    const limits = thresholdsFor(system);

    return answer?.kind === "noul" && Number.isFinite(answer.value) && answer.value >= limits.high && answer.value <= 1;
}

/** True when the Noul is confidently no. Not the negation of nounTrue: the middle band is silence. */
export function nounFalse(answer, system) {
    const limits = thresholdsFor(system);

    return answer?.kind === "noul" && Number.isFinite(answer.value) && answer.value >= 0 && answer.value <= limits.low;
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
 *
 * The reachability pass confirms all 40 Choice answers from this backend carried a distribution, so
 * the margin is a live test rather than a branch that silently never runs.
 */
export function choiceValue(answer, system) {
    if (
        answer?.kind !== "choice" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence > 1 ||
        !answer.probabilities ||
        Array.isArray(answer.probabilities) ||
        !Object.hasOwn(answer.probabilities, answer.value) ||
        !Object.values(answer.probabilities).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    ) {
        return undefined;
    }

    const limits = thresholdsFor(system);
    if (answer.confidence < limits.choiceConfidence) {
        return undefined;
    }

    const { first, second } = topTwo(answer.probabilities);
    if (answer.probabilities[answer.value] !== first || first - second < limits.margin) {
        return undefined;
    }

    return answer.value;
}

/**
 * A Score is actionable when it is confident and sits clear of the nearest level boundary. The
 * returned level is the rounded band; callers compare against their own rubric.
 */
export function scoreLevel(answer, system) {
    if (
        answer?.kind !== "score" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence > 1 ||
        !Number.isFinite(answer.value) ||
        answer.value < 0 ||
        answer.value > 9
    ) {
        return undefined;
    }

    const limits = thresholdsFor(system);
    if (answer.confidence < limits.scoreConfidence) {
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

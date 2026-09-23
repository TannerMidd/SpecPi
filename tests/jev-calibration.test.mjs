import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CALIBRATION, THRESHOLDS } from "../extensions/jev-advisor/gate.mjs";
import { choiceValue, nounFalse, nounTrue, scoreLevel } from "../extensions/jev-advisor/gate.mjs";
import { MIN_COVERAGE, MIN_LIFT, PRECISION_TARGETS } from "../scripts/jev-calibrate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(root, "evals", "runs", "jev-calibration.json");

// The point of this file. Every number in gate.mjs used to be a placeholder with a PROVISIONAL
// comment, and the layer shipped anyway. Pinning each one to a recorded artifact is what makes
// "changing a threshold requires new evidence" a mechanism rather than an intention: move a number
// without re-running `node scripts/jev-calibrate.mjs`, and these fail.
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

// The reach-only pass, built as a session builds its state. The calibration artifact's own reach
// section predates the production builders and the current gap questions, so questions asked only
// since then are pinned here instead.
const current = JSON.parse(fs.readFileSync(path.join(root, "evals", "runs", "jev-reach-hard.json"), "utf8"));

function currentFixture(key) {
    const bucket = current.reach.questions[key];
    assert.ok(bucket, `the reach artifact has no answers for ${key}`);

    return bucket.values;
}

/** Every recorded answer for one fixture question, across the repeats. */
function fixture(key) {
    const bucket = artifact.reach.questions[key];
    assert.ok(bucket, `the calibration artifact has no fixture answers for ${key}`);

    return bucket;
}

test("the artifact is the published matrix, not whatever happened to be on disk", () => {
    assert.equal(artifact.schema, 2);
    assert.deepEqual(
        artifact.reports,
        [1, 2, 3, 4, 5].map((tier) => `evals/runs/full-tier${tier}/report.json`),
    );
    assert.equal(artifact.attempts, artifact.scored + artifact.failures.length);
    assert.ok(artifact.attempts >= 259, "the corpus should not shrink without someone saying so");
});

test("the numbers gate.mjs cites are the numbers the artifact recorded", () => {
    // A comment that quotes a measurement and then drifts from it reads like evidence and is not.
    const close = (actual, expected, what) =>
        assert.ok(
            Math.abs(actual - expected) <= CALIBRATION.tolerance,
            `${what}: gate.mjs says ${expected}, the artifact says ${actual.toFixed(3)}`,
        );

    assert.equal(CALIBRATION.attempts, artifact.attempts);
    close(artifact.baseRates.pass, CALIBRATION.passBaseRate, "pass base rate");
    close(artifact.baseRates.tier, CALIBRATION.tierBaseRate, "tier base rate");
    close(artifact.baseRates.category, CALIBRATION.categoryBaseRate, "category base rate");

    const point = artifact.score.find((row) => row.confidence === 0.6 && row.boundary === 0.3);
    assert.ok(point, "the cited score point is not on the recorded curve");
    close(point.accuracy, CALIBRATION.scoreExact, "score exact accuracy");
    close(point.withinOne, CALIBRATION.scoreWithinOne, "score within-one accuracy");
    close(point.coverage, CALIBRATION.scoreCoverage, "score coverage");
});

test("the score thresholds are a point that exists on the recorded curve", () => {
    for (const [system, limits] of Object.entries(THRESHOLDS)) {
        const point = artifact.score.find(
            (row) => row.confidence === limits.scoreConfidence && row.boundary === limits.boundary,
        );
        assert.ok(point, `${system}: scoreConfidence/boundary is not a point the calibration measured`);
        assert.ok(point.gated > 0, `${system}: the chosen score point admitted nothing in the corpus`);
        assert.ok(
            point.coverage >= MIN_COVERAGE,
            `${system}: the chosen score point admits ${(point.coverage * 100).toFixed(1)}% of answers`,
        );
        // The Score curve is the one primitive that carries signal, so it must at least beat the
        // majority class. It does not meet the precision targets, and the next test pins that too.
        assert.ok(
            point.accuracy / point.baseRate >= MIN_LIFT,
            `${system}: the chosen score point has lift ${(point.accuracy / point.baseRate).toFixed(2)}`,
        );
    }
});

test("no system claims a precision it did not measure", () => {
    // gate.mjs says in as many words that no pre-registered target is met. If a future curve does
    // meet one, this fails and the header has to be rewritten to say so -- which is the point.
    for (const system of Object.keys(PRECISION_TARGETS)) {
        const point = artifact.operating[system];
        assert.ok(point, `${system} is missing from the artifact's operating points`);
        assert.equal(point.target, PRECISION_TARGETS[system]);
        for (const primitive of ["high", "low", "choice"]) {
            assert.equal(
                point[primitive].met,
                false,
                `${system}/${primitive} now meets its target; gate.mjs still says nothing does`,
            );
        }
    }
});

test("retention can actually reach the verdict that does something", () => {
    // The defect this whole pass existed to find. At the shipped confidence 0.80 / boundary 0.35
    // every one of these five clear-cut answers was rejected, so the elide branch was unreachable
    // and a never-firing system is indistinguishable from one that always advises nothing.
    const relevance = fixture("retention/obviously spent listing/future_relevance");
    const answer = fixture("retention/obviously spent listing/contains_the_answer");
    for (const [index, value] of relevance.values.entries()) {
        const level = scoreLevel({ kind: "score", value, confidence: relevance.confidences[index] }, "retention");
        assert.equal(level, 0, `a spent listing scored ${value} at confidence ${relevance.confidences[index]}`);
    }

    for (const value of answer.values) {
        assert.equal(nounFalse({ kind: "noul", value }, "retention"), true, `contains_the_answer was ${value}`);
    }

    // And the other half: a load-bearing read must still gate through to "keep", or the fix would
    // have bought reachability by making the gate meaningless.
    const kept = fixture("retention/obviously load-bearing read/future_relevance");
    for (const [index, value] of kept.values.entries()) {
        assert.notEqual(scoreLevel({ kind: "score", value, confidence: kept.confidences[index] }, "retention"), 0);
    }
});

test("gap's sanitization gate blocks a written secret or identity and passes a mention of one", () => {
    const blocks = (label) =>
        currentFixture(`gap/${label}/contains_secret`).map((value, index) => {
            const identity = currentFixture(`gap/${label}/names_person_or_machine`)[index];

            return nounTrue({ kind: "noul", value }, "gap") || nounTrue({ kind: "noul", value: identity }, "gap");
        });

    for (const label of [
        "a secret the redaction patterns miss",
        "a report carrying redaction markers",
        "a report naming a user and a host",
    ]) {
        assert.ok(blocks(label).every(Boolean), `${label} was not blocked every time`);
    }

    for (const label of [
        "a clean, reusable report",
        "a report that only mentions passwords",
        "a transient network failure",
        // Redacted before Jev sees it, and again before the wishlist stores it.
        "a report quoting a machine-specific path",
    ]) {
        assert.ok(!blocks(label).some(Boolean), `${label} was blocked`);
    }
});

test("system 7 flags a page fetched through the shell that addresses the agent, and not a JSON response", () => {
    for (const value of currentFixture(
        "untrusted/a page fetched with curl that addresses the agent/contains_instructions_to_agent",
    )) {
        assert.equal(nounTrue({ kind: "noul", value }, "untrusted"), true, `the planted page scored ${value}`);
    }

    for (const value of currentFixture(
        "untrusted/a JSON API response fetched with curl/contains_instructions_to_agent",
    )) {
        assert.equal(nounTrue({ kind: "noul", value }, "untrusted"), false, `a JSON response scored ${value}`);
    }
});

test("source ranking gates the obvious file through and the noise out", () => {
    const relevant = fixture("sources/one plainly relevant file among noise/source_1");
    for (const [index, value] of relevant.values.entries()) {
        assert.equal(scoreLevel({ kind: "score", value, confidence: relevant.confidences[index] }, "sources"), 2);
    }

    for (const name of ["source_0", "source_2"]) {
        const noise = fixture(`sources/one plainly relevant file among noise/${name}`);
        for (const [index, value] of noise.values.entries()) {
            assert.equal(scoreLevel({ kind: "score", value, confidence: noise.confidences[index] }, "sources"), 0);
        }
    }
});

test("system 7 separates a page that addresses the agent from one that does not", () => {
    // The plan's own condition was that this does not ship if the curve is weak on this question.
    // These are the recorded answers to that question.
    for (const value of fixture("untrusted/a fetched page addressing the agent/contains_instructions_to_agent")
        .values) {
        assert.equal(nounTrue({ kind: "noul", value }, "untrusted"), true, `an injected page scored ${value}`);
    }

    for (const value of fixture("untrusted/an ordinary fetched page/contains_instructions_to_agent").values) {
        assert.equal(nounTrue({ kind: "noul", value }, "untrusted"), false, `an ordinary page scored ${value}`);
    }
});

test("system 6 separates a request that needs a browser from one that does not", () => {
    for (const value of fixture("capability/a request that plainly needs a browser/needs_browser").values) {
        assert.equal(nounTrue({ kind: "noul", value }, "capability"), true, `a layout request scored ${value}`);
    }

    for (const name of ["needs_browser", "needs_web"]) {
        for (const value of fixture(`capability/a request that needs neither/${name}`).values) {
            assert.equal(nounTrue({ kind: "noul", value }, "capability"), false, `${name} scored ${value} on a rename`);
        }
    }
});

test("a threshold outside the range the model emits is refused", () => {
    const noul = artifact.reach.byKind.noul;
    // sources.high is the one deliberate exception, recorded here rather than left as a silent
    // hole: nothing in the fixture reaches it, and the only reader warns instead of blocking.
    const exceptions = new Set(["sources.high"]);
    for (const [system, limits] of Object.entries(THRESHOLDS)) {
        if (!exceptions.has(`${system}.high`)) {
            assert.ok(
                limits.high <= noul.valueMax,
                `${system}.high ${limits.high} is above the highest Noul ever observed (${noul.valueMax})`,
            );
        }

        assert.ok(
            limits.low >= noul.valueMin,
            `${system}.low ${limits.low} is below the lowest Noul ever observed (${noul.valueMin})`,
        );
    }

    const choice = artifact.reach.byKind.choice;
    assert.equal(
        choice.withDistribution,
        choice.n,
        "every Choice answer must carry a distribution, or the margin test is a branch that never runs",
    );
    for (const [system, limits] of Object.entries(THRESHOLDS)) {
        assert.ok(
            limits.choiceConfidence <= choice.confidenceMax,
            `${system}.choiceConfidence ${limits.choiceConfidence} exceeds every observed Choice confidence`,
        );
    }

    // And the margin has to be satisfiable by a real distribution, not just by its absence.
    assert.equal(
        choiceValue(
            { kind: "choice", value: "listing", confidence: 0.99, probabilities: { listing: 0.95, search: 0.02 } },
            "retention",
        ),
        "listing",
    );
});

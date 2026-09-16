import assert from "node:assert/strict";
import test from "node:test";
import { experimentCardEditorText, parseExperimentCard } from "../src/card.mjs";

test("card fields are read after the colon and trimmed", () => {
    const card = parseExperimentCard(
        ["Name: retry backoff", "Hypothesis: jitter removes the thundering herd", "Acceptance: p99 under 400ms"].join(
            "\n",
        ),
        "fallback",
    );
    assert.equal(card.name, "retry backoff");
    assert.equal(card.hypothesis, "jitter removes the thundering herd");
    assert.equal(card.acceptance, "p99 under 400ms");
    assert.deepEqual(card.nonGoals, []);
});

// The separator is whitespace, not the letter it is spelled with: a value that begins with
// "s" must survive intact. This is the case an unescaped `\s` in the field pattern eats.
test("a value starting with the separator's own letter is not consumed", () => {
    const card = parseExperimentCard("Name:ssl handshake\nHypothesis:spans are missing", "fallback");
    assert.equal(card.name, "ssl handshake");
    assert.equal(card.hypothesis, "spans are missing");
});

test("tabs and repeated spaces after the colon are separators", () => {
    const card = parseExperimentCard("Name:\tTabbed\nHypothesis:   padded", "fallback");
    assert.equal(card.name, "Tabbed");
    assert.equal(card.hypothesis, "padded");
});

test("a missing or empty name falls back and other fields stay empty", () => {
    const card = parseExperimentCard("Hypothesis: only this\n", "generated-name");
    assert.equal(card.name, "generated-name");
    assert.equal(card.acceptance, "");
    assert.deepEqual(card.nonGoals, []);
});

test("non-goals take every bullet after the heading and drop blank lines", () => {
    const card = parseExperimentCard(
        ["Name: trial", "Non-goals:", "- no schema change", "", "-   no new dependency", "   - no rollout"].join("\n"),
        "fallback",
    );
    assert.deepEqual(card.nonGoals, ["no schema change", "no new dependency", "no rollout"]);
});

test("a blank card round-trips through the editor template", () => {
    const template = experimentCardEditorText(undefined, "my-idea");
    const card = parseExperimentCard(template, "my-idea");
    assert.equal(card.name, "my-idea");
    assert.equal(card.hypothesis, "");
    assert.equal(card.acceptance, "");
    assert.deepEqual(card.nonGoals, []);
});

test("a task contract prefills the template and survives a round trip", () => {
    const contract = {
        objective: "Cut cold-start latency",
        hypothesis: "Lazy-loading the parser dominates startup",
        requirements: [
            { id: "R1", acceptance: "cold start under 200ms" },
            { id: "R2", acceptance: "no regression in warm path" },
        ],
        nonGoals: ["no API change"],
    };
    const template = experimentCardEditorText(contract, "unused-fallback");
    const card = parseExperimentCard(template, "unused-fallback");
    assert.equal(card.name, "Cut cold-start latency");
    assert.equal(card.hypothesis, "Lazy-loading the parser dominates startup");
    assert.equal(card.acceptance, "R1: cold start under 200ms; R2: no regression in warm path");
    assert.deepEqual(card.nonGoals, ["no API change"]);
});

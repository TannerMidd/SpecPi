import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { advisorTotals, modelRequests } from "../scripts/eval-proxy.mjs";
import { auditCorpus } from "../evals/lib/tier6/audit.mjs";
import { isDisclosure } from "../evals/lib/tier6/key.mjs";
import { DEFAULT_BUDGETS, defaultSettings, normalizeSettings } from "../extensions/jev-advisor/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The bug this covers ran in every published eval.
 *
 * eval-harnesses.mjs composed the advisor settings as a literal carrying a hardcoded schema
 * number, under a comment saying it had to track config.mjs. config.mjs moved on, and the migration
 * for that number read the old preference from a key the literal never had. So a system resolved to
 * false, the specpi-jev row measured fewer systems than it reported, and the tier 6 task built
 * around it recorded zero calls -- which read as "the system declined to fire" rather than "the
 * system was off".
 *
 * Nothing compared the settings to what the advisor read back. This does.
 */
test("the eval harness advisor settings resolve to the systems they ask for", () => {
    const wanted = {
        retention: true,
        gap: true,
        sources: false,
        progress: true,
        untrusted: true,
        capability: false,
    };

    const resolved = normalizeSettings({
        ...defaultSettings(),
        master: true,
        startup: true,
        systems: { ...wanted },
        budgets: { ...DEFAULT_BUDGETS },
        progressNudge: "message",
    });

    assert.equal(resolved.master, true, "the master switch must survive normalisation");
    for (const [name, on] of Object.entries(wanted)) {
        assert.equal(resolved.systems[name], on, `${name} asked for ${on} and resolved to ${resolved.systems[name]}`);
    }

    // Every system the advisor knows about is asked for or deliberately declined, so a system
    // added to config.mjs without a decision here fails rather than being measured as off.
    assert.deepEqual(
        Object.keys(resolved.systems).sort(),
        Object.keys(wanted).sort(),
        "a system exists that the eval row neither enables nor declines",
    );

    // The command guard is not one of them: it is a separate package these homes do not install,
    // and it keeps its own switch in its own file. No settings literal can reach it, whichever of
    // the two keys older schemas used it spells.
    const stale = normalizeSettings({
        schema: 2,
        master: true,
        startup: true,
        systems: { ...wanted, guard: true },
        guard: { enabled: true, startup: true },
    });
    assert.ok(!("guard" in stale.systems), "the guard is not a system; do not add one");
    assert.ok(!("guard" in stale), "and the layer's settings carry no answer about it at all");
});

/**
 * Both shipped corpora, audited on every test run rather than only at generation.
 *
 * Tier 6 shipped twice with a corpus that could be separated without being read -- the second time
 * by a single grep with four alternations that returned the answer exactly. Regenerating is the only
 * thing that runs the audit otherwise, and a corpus is regenerated about once.
 */
for (const task of ["t6-retention-haystack", "t6-context-marathon"]) {
    test(`${task} cannot be separated without reading it`, () => {
        const dir = path.join(root, "evals", "tasks", task, "workspace", "incidents");
        const docs = fs
            .readdirSync(dir)
            .sort()
            .map((entry) => {
                const text = fs.readFileSync(path.join(dir, entry), "utf8");

                return { id: entry.replace(/\.md$/u, ""), text, disclosure: isDisclosure(text, entry) };
            });

        assert.ok(docs.length > 0, "corpus is missing; run node evals/lib/tier6/generate.mjs");
        const { findings } = auditCorpus(docs);
        assert.deepEqual(findings, [], `separable corpus:\n  ${findings.join("\n  ")}`);
    });

    test(`${task} answer key matches what the reports say`, async () => {
        const dir = path.join(root, "evals", "tasks", task, "workspace", "incidents");
        const derived = fs
            .readdirSync(dir)
            .sort()
            .filter((entry) => isDisclosure(fs.readFileSync(path.join(dir, entry), "utf8"), entry))
            .map((entry) => entry.replace(/\.md$/u, ""));

        // The checker's literal is the contract; the key re-derives it from the prose. They agree
        // only while the corpus still encodes the rule the prompt states.
        const checker = fs.readFileSync(path.join(root, "evals", "tasks", task, "check.mjs"), "utf8");
        const expected = [...checker.matchAll(/"(INC-\d+)"/gu)].map((match) => match[1]);
        assert.deepEqual(derived, expected);
    });
}

/**
 * Advisor posts are not conversation turns.
 *
 * The advisor reaches the model through the same proxy as the agent, deliberately, so that its
 * spend lands in the same accounting rather than hiding outside it. eval-run then recorded
 * `proxy.requests.length` as the attempt's model-request count, which folded those posts into the
 * turn count: specpi-jev appeared to take 39 turns where plain SpecPi took 16 for the same task and
 * the same result, because 23 of the 39 were the advisor asking its own questions.
 *
 * eval-proxy has exported the filter that prevents this all along, and `series` and
 * `tokens.withUsage` both used it -- so the report carried the right number twice beside the wrong
 * one. This pins the three together.
 */
test("advisor calls are excluded from the model request count", () => {
    const log = [
        { kind: "model", usage: { prompt_tokens: 100 } },
        { kind: "advisor", ok: true, inputTokens: 40 },
        { kind: "model", usage: { prompt_tokens: 200 } },
        { kind: "advisor", ok: true, inputTokens: 40 },
        { kind: "advisor", ok: false, inputTokens: 0 },
        { kind: "model", usage: { prompt_tokens: 300 } },
    ];

    assert.equal(modelRequests(log).length, 3, "three turns happened; the other three were advisor posts");
    assert.equal(advisorTotals(log).calls, 3);
    assert.equal(
        modelRequests(log).length + advisorTotals(log).calls,
        log.length,
        "in a log of turns and advisor posts the two counts must partition it",
    );
});

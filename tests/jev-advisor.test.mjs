import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBroker } from "../extensions/jev-advisor/broker.mjs";
import {
    SYSTEM_NAMES,
    defaultSettings,
    keyPresent,
    loadSettings,
    saveSettings,
    settingsPath,
} from "../extensions/jev-advisor/config.mjs";
import { consentPath, endpointLabel, granted, revokeConsent, saveConsent } from "../extensions/jev-advisor/consent.mjs";
import {
    apiKey,
    ask,
    backend,
    choice,
    defaultModel,
    endpoint,
    noul,
    score,
} from "../extensions/jev-advisor/client.mjs";
import { choiceValue, nounFalse, nounTrue, scoreLevel } from "../extensions/jev-advisor/gate.mjs";
import { ledgerPath, read as readLedger, record } from "../extensions/jev-advisor/ledger.mjs";
import { MAX_STATE_BYTES, buildState, looksAbsolute, outline, redact } from "../extensions/jev-advisor/sanitize.mjs";
import * as retention from "../extensions/jev-advisor/questions/retention.mjs";
import * as compaction from "../extensions/jev-advisor/questions/compaction.mjs";
import * as gap from "../extensions/jev-advisor/questions/gap.mjs";
import * as sources from "../extensions/jev-advisor/questions/sources.mjs";
import {
    GUARD_PIN,
    applyConfig,
    configPath,
    desiredConfig,
    readConfig,
    statusLine,
} from "../extensions/jev-advisor/guard.mjs";
import { basePackages } from "../scripts/packages.mjs";
import { AUTHORING_TOOL_NAMES, syncAuthoringTools } from "../extensions/tool-wishlist/authoring-tools.mjs";

/** Every test gets its own agent directory so nothing reads or writes the developer's real state. */
function withAgentDir(run) {
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousKey = process.env.TYPESAFE_API_KEY;
    const previousBase = process.env.TYPESAFE_BASE_URL;
    // The guard's settings file lives under the user's home directory, not the agent directory, so
    // the home has to be redirected too or a test would write to the developer's real ~/.pi.
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-jev-test-")));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try {
        return run(dir);
    } finally {
        if (previousDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previousDir;
        }

        if (previousKey === undefined) {
            delete process.env.TYPESAFE_API_KEY;
        } else {
            process.env.TYPESAFE_API_KEY = previousKey;
        }

        if (previousBase === undefined) {
            delete process.env.TYPESAFE_BASE_URL;
        } else {
            process.env.TYPESAFE_BASE_URL = previousBase;
        }

        for (const [name, value] of [
            ["HOME", previousHome],
            ["USERPROFILE", previousProfile],
        ]) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }

        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const enabledSettings = (overrides = {}) => ({
    ...defaultSettings(),
    master: true,
    systems: Object.fromEntries(SYSTEM_NAMES.map((name) => [name, true])),
    ...overrides,
});

test("master off reaches no transport at all", async () => {
    await withAgentDir(async () => {
        let calls = 0;
        const broker = createBroker({
            loadSettings: () => defaultSettings(),
            ask: async () => {
                calls += 1;

                return { ok: true, answers: {} };
            },
            ensureConsent: async () => true,
            record: () => true,
        });

        const result = await broker.request({ system: "gap", state: { a: 1 }, questions: { q: noul("x") } });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "master-off");
        assert.equal(calls, 0, "the transport must never be reached with the master switch off");
    });
});

test("a system switched off is skipped while others still run", async () => {
    await withAgentDir(async () => {
        let calls = 0;
        const settings = enabledSettings({ systems: { retention: false, compaction: true, gap: true, sources: true } });
        const broker = createBroker({
            loadSettings: () => settings,
            ask: async () => {
                calls += 1;

                return { ok: true, answers: { q: { kind: "noul", value: 0.9 } } };
            },
            ensureConsent: async () => true,
            record: () => true,
        });

        assert.equal(
            (await broker.request({ system: "retention", state: {}, questions: { q: noul("x") } })).reason,
            "system-off",
        );
        assert.equal(calls, 0);
        assert.equal((await broker.request({ system: "gap", state: {}, questions: { q: noul("x") } })).ok, true);
        assert.equal(calls, 1);
    });
});

test("consent is required, and refusing it sends nothing", async () => {
    await withAgentDir(async () => {
        let calls = 0;
        const broker = createBroker({
            loadSettings: () => enabledSettings(),
            ask: async () => {
                calls += 1;

                return { ok: true, answers: {} };
            },
            ensureConsent: async () => false,
            record: () => true,
        });

        const result = await broker.request({ system: "gap", state: {}, questions: { q: noul("x") } });
        assert.equal(result.reason, "no-consent");
        assert.equal(calls, 0);
    });
});

test("the session call budget stops at its cap", async () => {
    await withAgentDir(async () => {
        let calls = 0;
        const broker = createBroker({
            loadSettings: () => enabledSettings({ callBudgetPerSession: 2 }),
            ask: async () => {
                calls += 1;

                return { ok: true, answers: { q: { kind: "noul", value: 0.5 } } };
            },
            ensureConsent: async () => true,
            record: () => true,
        });

        const once = { system: "gap", state: {}, questions: { q: noul("x") } };
        assert.equal((await broker.request(once)).ok, true);
        assert.equal((await broker.request(once)).ok, true);
        assert.equal((await broker.request(once)).reason, "budget-exhausted");
        assert.equal(calls, 2);

        broker.reset();
        assert.equal((await broker.request(once)).ok, true);
        assert.equal(calls, 3);
    });
});

test("a missing key, an HTTP error and a timeout all read as unavailable", async () => {
    await withAgentDir(async () => {
        delete process.env.TYPESAFE_API_KEY;
        assert.equal((await ask({}, { q: noul("x") })).reason, "no-key");

        process.env.TYPESAFE_API_KEY = "test-key";
        assert.equal((await ask({}, {})).reason, "no-questions");

        const server = await startStub((request, response) => {
            response.writeHead(500);
            response.end("nope");
        });
        try {
            process.env.TYPESAFE_BASE_URL = server.url;
            assert.equal((await ask({}, { q: noul("x") })).reason, "http-500");
        } finally {
            await server.close();
        }

        const slow = await startStub(() => {
            // Never respond: the client's own timeout is what has to fire.
        });
        try {
            process.env.TYPESAFE_BASE_URL = slow.url;
            const result = await ask({}, { q: noul("x") }, { timeoutMs: 60 });
            assert.equal(result.ok, false);
            assert.equal(result.reason, "timeout");
        } finally {
            await slow.close();
        }
    });
});

test("a malformed or empty answer body reads as unavailable", async () => {
    await withAgentDir(async () => {
        process.env.TYPESAFE_API_KEY = "test-key";
        const server = await startStub((request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ answers: { q: { unexpected: true } } }));
        });
        try {
            process.env.TYPESAFE_BASE_URL = server.url;
            assert.equal((await ask({}, { q: noul("x") })).reason, "empty-answers");
        } finally {
            await server.close();
        }
    });
});

test("answers normalize to one shape and a Noul never gains a confidence it did not report", async () => {
    await withAgentDir(async () => {
        process.env.TYPESAFE_API_KEY = "test-key";
        const server = await startStub((request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    model: "jev-1.13.0",
                    answers: {
                        a: { noul: 0.91 },
                        b: { choice: "billing", probabilities: { billing: 0.9, other: 0.1 }, confidence: 0.9 },
                        c: { score: 1.04, probabilities: [0.1, 0.8, 0.1], confidence: 0.8 },
                    },
                }),
            );
        });
        try {
            process.env.TYPESAFE_BASE_URL = server.url;
            const result = await ask(
                {},
                { a: noul("x"), b: choice("y", { billing: "b", other: "o" }), c: score("z", ["a", "b", "c"]) },
            );
            assert.equal(result.ok, true);
            assert.equal(result.answers.a.kind, "noul");
            assert.equal(result.answers.a.confidence, undefined);
            assert.equal(result.answers.b.kind, "choice");
            assert.equal(result.answers.b.value, "billing");
            assert.equal(result.answers.c.kind, "score");
            assert.equal(result.answers.c.value, 1.04);
        } finally {
            await server.close();
        }
    });
});

test("the default backend is OpenRouter, which is where the key works", () => {
    withAgentDir(() => {
        delete process.env.JEV_BACKEND;
        delete process.env.TYPESAFE_BASE_URL;
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.TYPESAFE_API_KEY;

        // Jev is published on OpenRouter. An sk-or- key is rejected by api.typesafe.ai with a bare
        // 401, so defaulting to the direct API silently fails every call for anyone holding the
        // key the model's own listing points them at.
        assert.equal(backend(), "openrouter");
        assert.match(endpoint(), /openrouter\.ai\/api\/alpha\/decisions$/u);
        assert.equal(defaultModel(), "typesafe/jev-1.13");

        process.env.JEV_BACKEND = "typesafe";
        assert.equal(backend(), "typesafe");
        assert.match(endpoint(), /api\.typesafe\.ai\/v1\/systemone$/u);
        assert.equal(defaultModel(), "jev-1.13.0");
        delete process.env.JEV_BACKEND;

        // The key variable follows the backend, matching the guard's own keyEnvName.
        assert.equal(apiKey(), undefined);
        process.env.OPENROUTER_API_KEY = "sk-or-v1-example";
        assert.equal(apiKey(), "sk-or-v1-example");
        assert.equal(keyPresent(), true);

        // An existing env file that put the OpenRouter key in TYPESAFE_API_KEY still works.
        delete process.env.OPENROUTER_API_KEY;
        process.env.TYPESAFE_API_KEY = "sk-or-v1-legacy";
        assert.equal(apiKey(), "sk-or-v1-legacy");
    });
});

test("gates behave at, above and below their thresholds", () => {
    assert.equal(nounTrue({ kind: "noul", value: 0.86 }, "gap"), true);
    assert.equal(nounTrue({ kind: "noul", value: 0.84 }, "gap"), false);
    assert.equal(nounFalse({ kind: "noul", value: 0.14 }, "gap"), true);
    assert.equal(nounFalse({ kind: "noul", value: 0.16 }, "gap"), false);
    // The middle band is silence, not a negation.
    assert.equal(nounTrue({ kind: "noul", value: 0.5 }, "gap"), false);
    assert.equal(nounFalse({ kind: "noul", value: 0.5 }, "gap"), false);

    // Confident overall but a coin flip between the top two: not actionable.
    assert.equal(
        choiceValue({ kind: "choice", value: "a", confidence: 0.9, probabilities: { a: 0.46, b: 0.44 } }, "gap"),
        undefined,
    );
    assert.equal(
        choiceValue({ kind: "choice", value: "a", confidence: 0.9, probabilities: { a: 0.8, b: 0.1 } }, "gap"),
        "a",
    );
    assert.equal(choiceValue({ kind: "choice", value: "a", confidence: 0.5 }, "gap"), undefined);

    // A score straddling a level boundary is not actionable.
    assert.equal(scoreLevel({ kind: "score", value: 1.5, confidence: 0.95 }, "gap"), undefined);
    assert.equal(scoreLevel({ kind: "score", value: 1.02, confidence: 0.95 }, "gap"), 1);
    assert.equal(scoreLevel({ kind: "score", value: 0.05, confidence: 0.5 }, "gap"), undefined);
});

test("the sanitizer strips credentials, relativizes paths and enforces the byte cap", () => {
    const redacted = redact("token=sk-abcdefgh12345678 at https://example.com/x for a@b.com", undefined);
    assert.ok(!redacted.includes("sk-abcdefgh12345678"), redacted);
    assert.ok(!redacted.includes("example.com"), redacted);
    assert.ok(!redacted.includes("a@b.com"), redacted);

    const root = process.platform === "win32" ? "F:/work/repo" : "/work/repo";
    const relative = redact(`${root}/src/index.js`, root);
    assert.equal(looksAbsolute(relative), false, relative);

    const built = buildState({ big: "x".repeat(20000), small: "keep" }, { maxBytes: 256 });
    assert.ok(built.bytes <= 256, `state was ${built.bytes} bytes`);
    assert.equal(built.truncated, true);
    JSON.parse(JSON.stringify(built.state));

    const capped = buildState({ note: "y".repeat(100000) });
    assert.ok(capped.bytes <= MAX_STATE_BYTES);
});

test("an outline reports shape and scale but never the whole body", () => {
    const body = Array.from({ length: 400 }, (_, index) => `line ${index} secret-payload`).join("\n");
    const shape = outline(body);
    assert.equal(shape.lines, 400);
    assert.ok(shape.bytes > 1000);
    assert.ok(shape.head.length <= 6);
    assert.ok(JSON.stringify(shape).length < body.length / 4);
});

test("the ledger records a hash and byte count, never the payload", () => {
    withAgentDir(() => {
        const secret = "sk-do-not-log-this-value";
        record({
            system: "gap",
            questionKeys: ["cluster"],
            stateBytes: 120,
            payloadSha256: "a".repeat(64),
            ok: true,
            latencyMs: 12,
            answers: { cluster: { kind: "choice", value: "x", confidence: 0.9 } },
        });
        const raw = fs.readFileSync(ledgerPath(), "utf8");
        assert.ok(!raw.includes(secret));
        assert.ok(raw.includes("a".repeat(64)));

        const entries = readLedger(5);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].system, "gap");
        assert.equal(entries[0].stateBytes, 120);
        assert.equal(entries[0].state, undefined, "the ledger must never carry the state it hashed");
    });
});

test("the broker writes one ledger line per call carrying the question keys", async () => {
    await withAgentDir(async () => {
        const written = [];
        const broker = createBroker({
            loadSettings: () => enabledSettings(),
            ask: async () => ({ ok: true, answers: { q: { kind: "noul", value: 0.9 } }, latencyMs: 5 }),
            ensureConsent: async () => true,
            record: (entry) => {
                written.push(entry);

                return true;
            },
        });

        await broker.request({ system: "gap", state: { secret: "sk-aaaaaaaaaaaaaaaa" }, questions: { q: noul("x") } });
        assert.equal(written.length, 1);
        assert.deepEqual(written[0].questionKeys, ["q"]);
        assert.equal(typeof written[0].payloadSha256, "string");
        assert.equal(written[0].payloadSha256.length, 64);
        assert.ok(!JSON.stringify(written[0]).includes("sk-aaaaaaaaaaaaaaaa"));
    });
});

test("settings refuse a symlink and read an unknown shape as off", () => {
    withAgentDir((dir) => {
        assert.equal(loadSettings().master, false);

        saveSettings(enabledSettings());
        assert.equal(loadSettings().master, true);

        fs.writeFileSync(settingsPath(), JSON.stringify({ schema: 99, master: true }));
        assert.equal(loadSettings().master, false, "an unknown schema must read as off");

        fs.writeFileSync(settingsPath(), "{ not json");
        assert.equal(loadSettings().master, false);

        fs.rmSync(settingsPath());
        const target = path.join(dir, "elsewhere.json");
        fs.writeFileSync(target, JSON.stringify(enabledSettings()));
        try {
            fs.symlinkSync(target, settingsPath());
        } catch {
            return; // Windows without developer mode cannot create the link; the guard is still covered above.
        }

        assert.equal(loadSettings().master, false, "a symlinked settings file must read as off");
    });
});

test("an oversize settings file reads as off rather than being parsed", () => {
    withAgentDir(() => {
        saveSettings(enabledSettings());
        fs.writeFileSync(settingsPath(), `${JSON.stringify(enabledSettings())}\n${"/".repeat(8192)}`);
        assert.equal(loadSettings().master, false);
    });
});

test("consent is stored, readable and revocable", () => {
    withAgentDir(() => {
        assert.equal(granted(), false);
        saveConsent();
        assert.equal(granted(), true);
        assert.ok(fs.existsSync(consentPath()));
        revokeConsent();
        assert.equal(granted(), false);
    });
});

// The default backend moved from the direct TypeSafe API to OpenRouter, and for a while the dialog
// went on naming api.typesafe.ai while the bytes went to openrouter.ai. Nothing failed, because the
// grant was keyed on the same fixed string it was written with, so the mismatch was invisible. This
// pins the property the comment in consent.mjs always claimed: a grant covers one destination.
test("a grant is keyed to the endpoint it was actually given for", () => {
    withAgentDir(() => {
        const previousBackend = process.env.JEV_BACKEND;
        delete process.env.JEV_BACKEND;
        delete process.env.TYPESAFE_BASE_URL;
        try {
            assert.equal(endpointLabel(), "openrouter.ai");
            saveConsent();
            assert.equal(granted(), true);
            assert.equal(JSON.parse(fs.readFileSync(consentPath(), "utf8")).endpoint, "openrouter.ai");

            // The direct API is a different company's host receiving the same bytes.
            process.env.JEV_BACKEND = "typesafe";
            assert.equal(endpointLabel(), "api.typesafe.ai");
            assert.equal(granted(), false);

            // So is anywhere TYPESAFE_BASE_URL points, which is how the eval proxy is reached.
            delete process.env.JEV_BACKEND;
            process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:8787";
            assert.equal(endpointLabel(), "127.0.0.1:8787");
            assert.equal(granted(), false);

            // Granting again covers the new destination and only that one.
            saveConsent();
            assert.equal(granted(), true);
            delete process.env.TYPESAFE_BASE_URL;
            assert.equal(granted(), false);
        } finally {
            if (previousBackend === undefined) {
                delete process.env.JEV_BACKEND;
            } else {
                process.env.JEV_BACKEND = previousBackend;
            }
        }
    });
});

test("retention only considers large read-only results", () => {
    const big = "x".repeat(5000);
    assert.equal(retention.eligible({ toolName: "read", content: [{ type: "text", text: big }] }), true);
    assert.equal(retention.eligible({ toolName: "write", content: [{ type: "text", text: big }] }), false);
    assert.equal(retention.eligible({ toolName: "edit", content: [{ type: "text", text: big }] }), false);
    assert.equal(retention.eligible({ toolName: "read", content: [{ type: "text", text: "short" }] }), false);
    assert.equal(
        retention.eligible({ toolName: "read", isError: true, content: [{ type: "text", text: big }] }),
        false,
    );
});

test("retention elides only when both answers are confident and agree", () => {
    const spent = {
        future_relevance: { kind: "score", value: 0.02, confidence: 0.95 },
        contains_the_answer: { kind: "noul", value: 0.02 },
    };
    assert.equal(retention.decide(spent).elide, true);

    const maybeAnswer = { ...spent, contains_the_answer: { kind: "noul", value: 0.5 } };
    assert.equal(retention.decide(maybeAnswer).elide, false);

    const loadBearing = {
        future_relevance: { kind: "score", value: 2.0, confidence: 0.95 },
        contains_the_answer: { kind: "noul", value: 0.02 },
    };
    assert.equal(retention.decide(loadBearing).elide, false);

    const unconfident = {
        future_relevance: { kind: "score", value: 0.02, confidence: 0.4 },
        contains_the_answer: { kind: "noul", value: 0.02 },
    };
    assert.equal(retention.decide(unconfident).elide, false);
});

test("the retention digest keeps head and tail and says the result is recoverable", () => {
    const body = Array.from({ length: 200 }, (_, index) => `row ${index}`).join("\n");
    const digest = retention.digest(body, { tool: "bash", bytes: Buffer.byteLength(body) });
    assert.ok(digest.includes("row 0"));
    assert.ok(digest.includes("row 199"));
    assert.ok(digest.includes("Re-run"));
    assert.ok(digest.length < body.length);
    assert.ok(!digest.includes("row 100"));
});

test("compaction advice is built only from gated answers", () => {
    assert.equal(compaction.decide({}).customInstructions, undefined);

    const advice = compaction.decide({
        work_kind: {
            kind: "choice",
            value: "debugging",
            confidence: 0.9,
            probabilities: { debugging: 0.9, building: 0.05 },
        },
        unresolved_thread: { kind: "noul", value: 0.95 },
        discarded_span_was_dead_ends: { kind: "noul", value: 0.95 },
    });
    assert.ok(advice.customInstructions.includes("debugging"));
    assert.ok(advice.unresolved);
    assert.ok(advice.deadEnds);

    // An ungated choice contributes nothing rather than guessing.
    const partial = compaction.decide({ work_kind: { kind: "choice", value: "debugging", confidence: 0.4 } });
    assert.equal(partial.customInstructions, undefined);
});

test("gap clustering offers every known key under the cardinality cap and falls back above it", () => {
    const few = [{ canonicalKey: "scope-drift", title: "Scope drift" }];
    const options = gap.clusterOptions(few, { capability: "scope", scenario: "drift" });
    assert.ok(Object.hasOwn(options, gap.NEW_CLUSTER));
    assert.ok(Object.hasOwn(options, "scope-drift"));

    const many = Array.from({ length: 400 }, (_, index) => ({
        canonicalKey: `key-${index}`,
        title: `Problem ${index}`,
    }));
    many.push({ canonicalKey: "browser-screenshot-diff", title: "Browser screenshot diff" });
    const capped = gap.clusterOptions(many, { capability: "browser screenshot", scenario: "diff" });
    assert.ok(Object.keys(capped).length <= gap.MAX_CLUSTER_OPTIONS + 1);
    assert.ok(Object.hasOwn(capped, "browser-screenshot-diff"), "similarity must keep the plausible match in range");
});

test("gap advice records an independent impact without overwriting the claim", () => {
    const advice = gap.decide({
        cluster: {
            kind: "choice",
            value: "scope-drift",
            confidence: 0.9,
            probabilities: { "scope-drift": 0.9, __new__: 0.05 },
        },
        independent_impact: { kind: "score", value: 0.02, confidence: 0.9 },
        suggested_fix: { kind: "choice", value: "tool", confidence: 0.9, probabilities: { tool: 0.9, bug: 0.05 } },
        contains_secret_or_path: { kind: "noul", value: 0.02 },
        is_transient_or_user_error: { kind: "noul", value: 0.02 },
    });
    assert.equal(advice.canonicalKey, "scope-drift");
    assert.equal(advice.independentImpact, "minor");
    assert.equal(advice.suggestedFix, "tool");
    assert.equal(advice.blockForSanitization, false);
    assert.equal(advice.transient, false);

    const leaking = gap.decide({ contains_secret_or_path: { kind: "noul", value: 0.97 } });
    assert.equal(leaking.blockForSanitization, true);
    assert.equal(leaking.canonicalKey, undefined);

    // A "new" cluster must not be written back as a canonical key.
    const fresh = gap.decide({
        cluster: {
            kind: "choice",
            value: gap.NEW_CLUSTER,
            confidence: 0.95,
            probabilities: { [gap.NEW_CLUSTER]: 0.95 },
        },
    });
    assert.equal(fresh.canonicalKey, undefined);
});

test("source ranking orders without dropping and keeps ungated items in place", () => {
    const candidates = [{ path: "a.js" }, { path: "b.js" }, { path: "c.js" }];
    const ranked = sources.decide(
        {
            source_0: { kind: "score", value: 0.02, confidence: 0.9 },
            source_1: { kind: "score", value: 2.0, confidence: 0.9 },
            source_2: { kind: "score", value: 1.5, confidence: 0.2 },
        },
        candidates,
    );
    assert.equal(ranked.ordered.length, 3, "ranking must never drop a candidate");
    assert.equal(ranked.ordered[0].path, "b.js");
    assert.deepEqual(ranked.unrelated, ["a.js"]);
    assert.equal(ranked.ordered.at(-1).path, "c.js", "an ungated score sorts last, not out");
});

test("the guard seam defers to the permission system and never auto-allows", () => {
    withAgentDir(() => {
        // The real specpi-jev-guard schema, not an invented one: applyPatch only reads these names.
        const config = desiredConfig();
        assert.equal(config.enabled, false, "the guard's own default is enabled:true, so SpecPi must override it");
        assert.equal(
            config.backend,
            "openrouter",
            "one OPENROUTER_API_KEY must power the advisor and the guard together",
        );
        assert.equal(config.uncertain, "ask");
        assert.equal(Object.hasOwn(config, "askThreshold"), false, "thresholds stay the package's business");
        assert.match(statusLine(), /not installed/u);
        assert.equal(applyConfig().reason, "not-installed", "an absent guard is never configured into existence");
    });
});

test("the guard and the permission system are both pinned", () => {
    assert.ok(basePackages.includes(GUARD_PIN), `${GUARD_PIN} must be in the pinned base set`);
    assert.ok(
        basePackages.some((entry) => entry.startsWith("npm:@gotgenes/pi-permission-system@")),
        "the permission system must stay pinned: it is what decides every call while the guard is off",
    );
});

test("a fresh install writes the guard's inert posture without depending on the advisor loading", () => {
    withAgentDir((dir) => {
        const root = path.join(dir, "npm", "node_modules", "specpi-jev-guard");
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({ name: "specpi-jev-guard", version: "0.1.0" }),
        );

        // The guard's own DEFAULT_SETTINGS.enabled is true and it reads its file per tool call, so
        // an absent file means an active guard. With no key that fails closed on every gated call,
        // which is a first install that will not run commands. The installer calls this directly
        // for exactly that reason.
        assert.equal(readConfig(), undefined, "no settings file yet");
        assert.equal(applyConfig(false).reason, "created");
        assert.equal(readConfig().enabled, false);
    });
});

test("nothing in the Jev layer is on by default", () => {
    withAgentDir(() => {
        const fresh = loadSettings();
        assert.equal(fresh.master, false);
        assert.equal(fresh.startup, false);
        assert.equal(fresh.guard.enabled, false);
        assert.equal(fresh.guard.startup, false);
        for (const name of SYSTEM_NAMES) {
            assert.equal(fresh.systems[name], false, `${name} must ship off`);
        }

        // Off is a real written configuration, not an absence of one.
        assert.equal(desiredConfig().enabled, false);
        assert.equal(desiredConfig(false).enabled, false);
        assert.equal(desiredConfig(true).enabled, true);
    });
});

test("a user can default the layer on without a session toggle writing that preference", () => {
    withAgentDir(() => {
        const saved = saveSettings({ ...defaultSettings(), startup: true, guard: { enabled: false, startup: true } });
        assert.equal(saved.startup, true);
        assert.equal(saved.guard.startup, true);
        assert.equal(loadSettings().guard.startup, true);

        // The stored preference is what a new session reads; enabling in-session must not reach it.
        assert.equal(loadSettings().guard.enabled, false);
    });
});

test("guard configuration is written once and is idempotent afterwards", () => {
    withAgentDir((dir) => {
        const root = path.join(dir, "npm", "node_modules", "specpi-jev-guard");
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({ name: "specpi-jev-guard", version: "0.1.0" }),
        );

        // A fresh install writes the inert posture, not an active one.
        assert.equal(applyConfig().reason, "created");
        const written = readConfig();
        assert.equal(written.enabled, false);
        assert.equal(written.backend, "openrouter");
        assert.ok(fs.existsSync(configPath()));
        assert.match(statusLine(), /installed but off/u);

        assert.equal(applyConfig().applied, false, "an unchanged config must not be rewritten");

        assert.equal(applyConfig(true).reason, "updated");
        assert.equal(readConfig().enabled, true);
        assert.match(statusLine(), /ON via openrouter/u);

        // A user's own thresholds and globs survive; only SpecPi's three fields are asserted.
        fs.writeFileSync(
            configPath(),
            JSON.stringify({ enabled: true, backend: "typesafe", askThreshold: 0.6, safeCommands: ["ls *"] }),
        );
        assert.equal(applyConfig(true).reason, "updated");
        const merged = readConfig();
        assert.equal(merged.backend, "openrouter", "the backend is re-pinned so one key still powers both halves");
        assert.equal(merged.askThreshold, 0.6, "a user threshold must not be clobbered");
        assert.deepEqual(merged.safeCommands, ["ls *"]);
    });
});

test("authoring tools follow the selection, and the observation tool is never withdrawn", () => {
    let active = ["bash", "read", "report_capability_gap", "request_capability", ...AUTHORING_TOOL_NAMES];
    const pi = {
        getActiveTools: () => [...active],
        setActiveTools: (next) => {
            active = [...next];
        },
    };

    assert.equal(syncAuthoringTools(pi, false), true);
    assert.deepEqual(active, ["bash", "read", "report_capability_gap", "request_capability"]);
    assert.ok(active.includes("report_capability_gap"), "the observation tool must always stay offered");
    assert.ok(active.includes("request_capability"), "the escape hatch must always stay offered");

    // Idempotent: a no-op must not churn the active set, which would cost the cached prefix.
    assert.equal(syncAuthoringTools(pi, false), false);

    assert.equal(syncAuthoringTools(pi, true), true);
    for (const name of AUTHORING_TOOL_NAMES) {
        assert.ok(active.includes(name));
    }

    assert.equal(syncAuthoringTools(pi, true), false);
    assert.equal(syncAuthoringTools({}, true), false, "an API without the tool accessors is a no-op");
});

async function startStub(handler) {
    const http = await import("node:http");
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(resolve);
            }),
    };
}

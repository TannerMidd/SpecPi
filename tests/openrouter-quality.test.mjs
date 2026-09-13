import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { QualityBudget } from "../scripts/quality-budget.mjs";
import {
    conforms,
    buildProviderSchedule,
    createCaller,
    requestPayload,
    resumeState,
    schemas,
    settings,
    trial,
} from "../scripts/openrouter-quality.mjs";
import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { tasks } from "../evals/quality/catalog.mjs";
import { suiteVersion } from "../evals/quality/catalog.mjs";
import { fixtureDigest } from "../evals/quality/fixtures.mjs";
import { repositoryRoot, sourceDigests, sha256 } from "../evals/quality/provenance.mjs";
import { collectOpenRouter } from "../scripts/export-openrouter-quality.mjs";
import { gradeFinalFiles } from "../scripts/replay-quality-results.mjs";

function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-openrouter-test-"));
    t.after(() => {
        if (
            path.dirname(root) === path.resolve(os.tmpdir()) &&
            path.basename(root).startsWith("specpi-openrouter-test-")
        ) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    return root;
}

test("spending reservations survive restart and refuse overspend, unknown usage and cap changes", (t) => {
    const file = path.join(temporary(t), "budget.json");
    const budget = new QualityBudget(file, 0.02);
    budget.reserve("first", 10000, 16384);
    assert.throws(() => budget.reserve("first", 100, 100), /duplicate/);
    assert.throws(() => budget.settle("first", 1000, 100, undefined), /usage/);
    const restored = new QualityBudget(file, 0.02);
    assert.equal(restored.totalMicros(), budget.totalMicros());
    assert.throws(() => restored.reserve("second", 10000, 16384), /cap reached/);
    assert.throws(() => new QualityBudget(file, 5), /cannot change/);
    restored.settle("first", 1000, 100, 0.0001);
    restored.reserve("second", 10000, 16384);
    assert.ok(restored.totalMicros() < 20000);
    assert.throws(() => restored.settle("second", 10001, 100, 0.001), /usage/);
});

test("provider adapter uses opaque synthetic credentials, pinned routing, no tools and bounded accounting", async (t) => {
    const budget = new QualityBudget(path.join(temporary(t), "budget.json"), 5);
    const credentials = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "synthetic-test-value" } });
    let requests = 0;
    const identity = { model: settings.model, provider: settings.providerNames[0] };
    t.mock.method(globalThis, "fetch", async (_input, init) => {
        requests += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.model, settings.model);
        assert.equal(body.max_tokens, 16384);
        assert.deepEqual(body.provider.only, settings.endpoints);
        assert.equal(body.provider.allow_fallbacks, true);
        assert.deepEqual(body.provider.quantizations, ["fp8"]);
        assert.deepEqual(body.provider.max_price, { prompt: 0.15, completion: 0.5, request: 0 });
        assert.equal(body.tools, undefined);
        assert.equal(body.response_format.json_schema.strict, true);
        const response = { calls: [], explanation: "Preserve the correct implementation." };
        const chunk = {
            id: "synthetic-response",
            ...identity,
            choices: [{ index: 0, delta: { content: JSON.stringify(response) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00002 },
        };

        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        });
    });
    const caller = await createCaller(budget, credentials);
    const result = await caller("synthetic", "Return an empty edit list.", schemas.native);
    assert.equal(result.infrastructureError, undefined);
    assert.equal(result.protocolFailure, false);
    assert.deepEqual(result.response.calls, []);
    assert.equal(result.usage.reportedCostUsd, 0.00002);
    assert.equal(requests, 1);
    assert.equal(budget.data.requests[0].status, "settled");
    assert.equal(JSON.stringify(budget.data).includes("synthetic-test-value"), false);
    assert.equal(JSON.stringify(result).includes("synthetic-test-value"), false);

    identity.provider = "Unexpected serving provider";
    const providerMismatch = await caller("wrong-provider", "Return an empty edit list.", schemas.native);
    assert.match(providerMismatch.infrastructureError, /identity differs/);
    assert.equal(providerMismatch.response, undefined);
    identity.provider = settings.providerNames[0];
    identity.model = "unexpected-model";
    const modelMismatch = await caller("wrong-model", "Return an empty edit list.", schemas.native);
    assert.match(modelMismatch.infrastructureError, /identity differs/);
    assert.equal(modelMismatch.response, undefined);
    assert.equal(
        budget.data.requests.every((item) => item.status === "settled"),
        true,
    );
});

test("structured model failures count as failures even when the starting control passes", async (t) => {
    const root = temporary(t);
    const task = tasks.find((item) => item.category === "negative-control");
    const record = await trial(
        { experiment: "editing", task, condition: "native", repetition: 1 },
        0,
        root,
        async () => ({ protocolFailure: true, elapsedMs: 1, toolEvents: [] }),
    );
    assert.equal(record.error, undefined);
    assert.equal(record.oracle.acceptance, "passed");
    assert.equal(record.acceptance, "failed");
    assert.deepEqual(record.changedFiles, []);
    assert.equal(record.calls.length, 1);
});

test("schemas reject surplus keys, malformed edits and arrays masquerading as objects", () => {
    assert.ok(conforms({ findings: [], limitations: [] }, schemas.review));
    assert.equal(conforms({ findings: [], limitations: [], extra: "ignored" }, schemas.review), false);
    assert.equal(
        conforms(
            { calls: [{ path: "main.mjs", edits: [{ oldText: 7, newText: "x" }] }], explanation: "" },
            schemas.native,
        ),
        false,
    );
    assert.equal(conforms([], schemas.native), false);
    const payload = requestPayload(
        { model: "other", tools: [{ name: "bash" }], plugins: [{ id: "web" }] },
        schemas.review,
    );
    assert.equal(payload.model, settings.model);
    assert.equal(payload.tools, undefined);
    assert.deepEqual(payload.plugins, []);
});

test("transient transport attempts are retained without spending an edit round", async (t) => {
    const root = temporary(t);
    const task = tasks.find((item) => item.category === "negative-control");
    let calls = 0;
    const record = await trial(
        { experiment: "editing", task, condition: "native", repetition: 1 },
        0,
        root,
        async () => {
            calls += 1;

            return calls < 3
                ? { infrastructureError: "Rate limited", metadata: { status: 429 }, elapsedMs: 1, toolEvents: [] }
                : {
                      response: { calls: [], explanation: "Preserve the correct interface." },
                      elapsedMs: 1,
                      toolEvents: [],
                  };
        },
    );
    assert.equal(record.acceptance, "passed");
    assert.equal(record.editRounds, 1);
    assert.equal(record.calls[0].priorAttempts.length, 2);
    assert.equal(record.calls[0].elapsedMs, 3);
});

test("resume preserves valid failures and detects drift, duplicates and interrupted attempts", (t) => {
    const root = temporary(t);
    const planned = { experiment: "editing", task: "intentional-interface", condition: "native", repetition: 1 };
    const manifest = {
        mode: "full",
        settings,
        fixtureDigests: { "intentional-interface": "fixture" },
        schedule: [planned],
    };
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    const id = "editing-001-intentional-interface-native-r1";
    const first = path.join(root, `${id}-attempt1`);
    fs.mkdirSync(first);
    assert.equal(resumeState(root, manifest).attempts.get(0), 1);
    const record = { ...planned, id, index: 0, attempt: 1, fixtureDigest: "fixture", acceptance: "failed" };
    fs.writeFileSync(path.join(first, "result.json"), JSON.stringify(record));
    assert.equal(resumeState(root, manifest).valid.get(0).acceptance, "failed");
    assert.throws(() => resumeState(root, { ...manifest, settings: { model: "different" } }), /frozen settings/);
    const second = path.join(root, `${id}-attempt2`);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, "result.json"), JSON.stringify({ ...record, attempt: 2 }));
    assert.throws(() => resumeState(root, manifest), /Duplicate/);
});

test("publication refuses an incomplete experiment or changed provider adapter", (t) => {
    const root = temporary(t);
    const manifest = {
        mode: "full",
        suiteVersion,
        sourceDigests: sourceDigests(),
        fixtureDigests: Object.fromEntries(tasks.map((task) => [task.id, fixtureDigest(task)])),
        schedule: buildProviderSchedule().map(({ task, ...run }) => ({ ...run, task: task.id })),
        adapterDigests: Object.fromEntries(
            ["openrouter-quality.mjs", "quality-budget.mjs", "replay-quality-results.mjs"].map((file) => [
                file,
                sha256(fs.readFileSync(path.join(repositoryRoot, "scripts", file))),
            ]),
        ),
    };
    const file = path.join(root, "manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, "completion.json"), JSON.stringify({ status: "incomplete" }));
    assert.throws(() => collectOpenRouter(root, path.join(root, "unused-ledger.json")), /384 valid/);
    manifest.adapterDigests["openrouter-quality.mjs"] = "changed";
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => collectOpenRouter(root, path.join(root, "unused-ledger.json")), /adapter differs/);
});

test("a candidate that never settles its promise is a behavioral failure", () => {
    const source = "export function mapLimit() { return new Promise(() => {}); }\n";
    const hash = sha256(source);
    const result = gradeFinalFiles("bounded-map", { "main.mjs": hash }, { [hash]: source });
    assert.equal(result.acceptance, "failed");
    assert.match(result.reason, /unsettled/);
});

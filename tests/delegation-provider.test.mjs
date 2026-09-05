import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";
import { createPiHost } from "../extensions/delegation/provider.mjs";

test("provider bridge rejects unsupported options before invoking inference", async () => {
    let calls = 0;
    const session = {
        agent: {
            state: { model: { id: "fixture", provider: "fixture" }, thinkingLevel: "off" },
            sessionId: "parent",
            convertToLlm: (messages) => messages,
            streamFunction() {
                calls += 1;
            },
        },
    };
    const host = createPiHost(session, { id: "owner", isCurrent: () => true });
    const context = { systemPrompt: "fixture", messages: [], tools: [] };
    const options = { signal: new AbortController().signal, sessionId: "child" };
    await assert.rejects(host.stream(context, { ...options, headers: {} }), /Unsupported/u);
    await assert.rejects(host.stream(context, { ...options, sessionId: "parent" }), /Invalid/u);
    await assert.rejects(host.stream(context, { ...options, maxTokens: 2049 }), /Invalid/u);
    await assert.rejects(host.stream(context, { ...options, timeoutMs: 0 }), /Invalid/u);
    await assert.rejects(host.stream({ ...context, systemPrompt: "x".repeat(256 * 1024) }, options), /256 KiB/u);
    assert.equal(calls, 0);
});

test("real Pi SDK preserves configured provider policy for bounded children", (context) => {
    const result = runPiFixture(path.resolve("tests/fixtures/delegation-provider-harness.ts"), {
        env: { SPECPI_DELEGATION_FIXTURE_MODE: "provider" },
    });
    if (result.unavailable) {
        context.skip(result.error?.message ?? "Pi is unavailable");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const marker = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/u)
        .find((line) => line.startsWith("DELEGATION_FIXTURE="));
    assert.ok(marker, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(marker.slice("DELEGATION_FIXTURE=".length));
    assert.equal(report.sdkVersion, "0.84.4");
    assert.equal(report.provider, true);
});

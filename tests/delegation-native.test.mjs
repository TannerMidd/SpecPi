import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

function runNativeFixture(context, mode = "main") {
    // Preserve the temp path spelling: the harness resolves both sides consistently,
    // including Windows runners whose TEMP uses an 8.3 short-name alias.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-native-child-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const fixture = path.resolve("tests/fixtures/delegation-native-harness.ts");
    const provider = "specpi-native-entry-fixture";
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(cwd, "fixture.md"), "Public native fixture evidence.\n");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "NATIVE_AMBIENT_CONTEXT_CANARY\n");
    fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
    fs.writeFileSync(
        path.join(cwd, ".pi", "extensions", "ambient.ts"),
        'throw new Error("NATIVE_AMBIENT_EXTENSION_CANARY");\n',
    );
    fs.mkdirSync(path.join(agentDir, "extensions"));
    fs.writeFileSync(
        path.join(agentDir, "extensions", "ambient.ts"),
        'throw new Error("NATIVE_AMBIENT_GLOBAL_EXTENSION_CANARY");\n',
    );
    fs.writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({
            providers: {
                [provider]: {
                    baseUrl: "http://127.0.0.1:1/v1",
                    api: "openai-completions",
                    apiKey: "synthetic-models-only",
                    models: [
                        {
                            id: "native-parent",
                            name: "Native child fixture",
                            reasoning: true,
                            input: ["text"],
                            contextWindow: 32768,
                            maxTokens: 16384,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            compat: {
                                supportsDeveloperRole: false,
                                supportsReasoningEffort: true,
                                maxTokensField: "max_tokens",
                            },
                        },
                    ],
                },
            },
        }),
    );
    const args = [
        "--offline",
        "--no-session",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--provider",
        provider,
        "--model",
        "native-parent",
        "--thinking",
        "high",
        "-e",
        fixture,
    ];
    if (mode === "reload") {
        args.push("--print", "/native-fixture-reload", "/native-fixture-replace");
    } else {
        args.push("--mode", "rpc");
    }

    if (mode === "runtime-auth") {
        args.push("--api-key", "synthetic-runtime-only");
    }

    try {
        const result = runPiFixture(fixture, {
            cwd,
            agentDir,
            args,
            input: mode === "reload" ? "" : undefined,
            env: {
                SPECPI_NATIVE_FIXTURE_MODE: mode,
                HTTP_PROXY: "",
                HTTPS_PROXY: "",
                ALL_PROXY: "",
                NO_PROXY: "",
                NODE_USE_ENV_PROXY: "",
            },
        });
        if (result.unavailable) {
            context.skip(result.error?.message ?? "Pi is unavailable");

            return undefined;
        }

        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

        return result;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function report(result, prefix) {
    const marker = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).find((line) => line.startsWith(`${prefix}=`));
    assert.ok(marker, `${result.stderr}\n${result.stdout}`);

    return JSON.parse(marker.slice(prefix.length + 1));
}

test("ordinary native Pi delegation runs real child sessions through configured localhost SSE", (context) => {
    const result = runNativeFixture(context);
    if (!result) {
        return;
    }

    const observed = report(result, "NATIVE_ENTRY_FIXTURE");
    for (const name of [
        "ordinaryEntryRegistered",
        "defaultOff",
        "headlessActivationDenied",
        "sameModelThinking",
        "snapshotRead",
        "strictGuardIntercepted",
        "noAmbientResources",
        "parentHooksNotInherited",
        "actualSdkToolLoop",
        "cancelledResultSuppressed",
        "rebindCountersPreserved",
        "oldCallbacksInert",
        "sourceFreshness",
        "batchQuotaPreserved",
        "registeredOverrideRejected",
        "activeToolGated",
    ]) {
        assert.equal(observed[name], true, name);
    }

    assert.equal(observed.calls, 8);
    assert.equal(observed.batches, 4);
    assert.deepEqual(observed.ceilings, {
        concurrency: 2,
        sessionCalls: 32,
        sessionBatches: 4,
        batchJobs: 2,
        outputTokens: 8192,
    });
});

test("ordinary Pi public reload and session replacement retain child-session counters", (context) => {
    const result = runNativeFixture(context, "reload");
    if (!result) {
        return;
    }

    assert.deepEqual(report(result, "NATIVE_RELOAD_FIXTURE"), {
        publicCommandReload: true,
        registrations: 2,
        reloadReason: "reload",
        enabled: false,
        activeTool: false,
        calls: 1,
        batches: 1,
        generationAdvanced: true,
        oldCallbackInert: true,
        lifecycle: ["command", "shutdown:reload", "start:reload"],
    });
    assert.deepEqual(report(result, "NATIVE_REPLACEMENT_FIXTURE"), {
        publicNewSession: true,
        registrations: 3,
        startReason: "new",
        freshContext: true,
        initiallyOff: true,
        callsBefore: 1,
        batchesBefore: 1,
        callsAfter: 2,
        batchesAfter: 2,
        newWorkerCompleted: true,
        oldCallbackInert: true,
        finallyOff: true,
    });
});

test("native child-session activation rejects a parent CLI runtime credential override", (context) => {
    const result = runNativeFixture(context, "runtime-auth");
    if (!result) {
        return;
    }

    assert.deepEqual(report(result, "NATIVE_RUNTIME_AUTH_FIXTURE"), {
        runtimeAuthRejected: true,
        enabled: false,
        requests: 0,
    });
});

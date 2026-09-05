import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";
import { createNativePiHost } from "../extensions/delegation/provider.mjs";

const context = { systemPrompt: "fixture", messages: [], tools: [] };
const options = () => ({ signal: new AbortController().signal, sessionId: "child-fixture" });
const message = (stopReason = "stop") => ({
    role: "assistant",
    content: [{ type: "text", text: "fixture", textSignature: "opaque-signature" }],
    stopReason,
    providerMetadata: { replay: "opaque-metadata" },
});

function fixture(implementation = async () => message()) {
    let calls = 0;
    let current = true;
    const ctx = {
        model: { id: "fixture", provider: "fixture" },
        modelRegistry: {
            complete(...args) {
                assert.equal(this, ctx.modelRegistry);
                calls += 1;

                return implementation(...args);
            },
        },
    };
    const host = createNativePiHost(ctx, { id: "owner", isCurrent: () => current });

    return {
        ctx,
        host,
        calls: () => calls,
        revoke: () => {
            current = false;
        },
    };
}

test("native adapter requires only the public registry and active model", async () => {
    for (const ctx of [undefined, {}, { model: {} }, { model: { id: "a", provider: "b" }, modelRegistry: {} }]) {
        assert.throws(
            () => createNativePiHost(ctx, { id: "owner", isCurrent: () => true }),
            /native Pi model registry/u,
        );
    }

    const { ctx } = fixture();
    for (const [target, keys] of [
        [ctx, ["sessionManager", "thinkingLevel", "agent", "settingsManager"]],
        [ctx.modelRegistry, ["runtime", "getApiKeyAndHeaders", "getProviderAuth", "getApiKeyForProvider"]],
    ]) {
        for (const key of keys) {
            Object.defineProperty(target, key, {
                get() {
                    throw new Error(`Unexpected access to ${key}`);
                },
            });
        }
    }

    const host = createNativePiHost(ctx, { id: "public-only", isCurrent: () => true });
    await host.stream(context, options()).then((stream) => stream.result());
    assert.deepEqual(Object.keys(host).sort(), ["id", "isCurrent", "model", "stream"]);
    assert.deepEqual(host.model, { id: "fixture", provider: "fixture" });
});

test("native adapter rejects unreviewed options and invalid contexts before inference", async () => {
    const { host, calls } = fixture();
    for (const invalid of [
        null,
        [],
        { ...options(), headers: {} },
        { ...options(), apiKey: "must-not-forward" },
        { ...options(), reasoning: "high" },
        { ...options(), transport: "sse" },
        { ...options(), maxRetries: 3 },
        { ...options(), maxTokens: 2049 },
        { ...options(), timeoutMs: 0 },
        { ...options(), sessionId: "" },
        { ...options(), [Symbol("hidden")]: true },
    ]) {
        await assert.rejects(host.stream(context, invalid), /Unsupported|Invalid/u);
    }

    for (const invalid of [null, [], { ...context, extra: true }, { ...context, messages: {} }]) {
        await assert.rejects(host.stream(invalid, options()), /Invalid delegation context/u);
    }

    await assert.rejects(host.stream({ ...context, systemPrompt: "x".repeat(256 * 1024) }, options()), /256 KiB/u);
    const cyclic = { ...context, messages: [] };
    cyclic.messages.push(cyclic);
    await assert.rejects(host.stream(cyclic, options()), /not serializable/u);
    const rewritten = Object.assign(Object.create({ toJSON: () => ({ ...context, extra: "injected" }) }), context);
    await assert.rejects(host.stream(rewritten, options()), /Invalid delegation context/u);
    assert.equal(calls(), 0);
});

test("native adapter rejects stale model, registry, method, callback, and aborted leases before dispatch", async () => {
    for (const mutate of [
        ({ ctx }) => {
            ctx.model = { ...ctx.model };
        },
        ({ ctx }) => {
            ctx.model.id = "changed";
        },
        ({ ctx }) => {
            ctx.model.provider = "changed";
        },
        ({ ctx }) => {
            ctx.modelRegistry = { ...ctx.modelRegistry };
        },
        ({ ctx }) => {
            ctx.modelRegistry.complete = async () => message();
        },
        ({ revoke }) => revoke(),
        ({ ctx }) => {
            Object.defineProperty(ctx, "model", {
                get() {
                    throw new Error("inactive runtime");
                },
            });
        },
    ]) {
        const state = fixture();
        mutate(state);
        assert.equal(state.host.isCurrent(), false);
        await assert.rejects(state.host.stream(context, options()), /lease/u);
        assert.equal(state.calls(), 0);
    }

    const state = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(state.host.stream(context, { ...options(), signal: controller.signal }), /cancelled/u);
    const mutating = {
        ...context,
        messages: [
            {
                toJSON() {
                    state.revoke();

                    return {};
                },
            },
        ],
    };
    await assert.rejects(state.host.stream(mutating, options()), /lease/u);
    assert.equal(state.calls(), 0);
});

test("native adapter forwards only reviewed common options and preserves opaque assistant replay fields", async () => {
    const answer = message("toolUse");
    answer.content.push({
        type: "toolCall",
        id: "call-1",
        name: "read_source",
        arguments: {},
        signature: "opaque-tool",
    });
    const requests = [];
    const state = fixture(async (model, input, requestOptions) => {
        requests.push({ model, input, requestOptions });

        return answer;
    });
    const input = { ...context, messages: [message()] };
    const stream = await state.host.stream(input, { ...options(), maxTokens: 17, timeoutMs: 4000 });
    const events = [];
    for await (const event of stream) {
        events.push(event);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "done");
    assert.equal(events[0].message, answer);
    assert.equal(await stream.result(), answer);
    assert.equal(await stream.result(), answer);
    assert.equal(state.calls(), 1);
    assert.equal(requests[0].model, state.ctx.model);
    assert.notEqual(requests[0].input, input);
    assert.deepEqual(requests[0].input, input);
    assert.deepEqual(Object.keys(requests[0].requestOptions).sort(), [
        "maxRetries",
        "maxTokens",
        "sessionId",
        "signal",
        "timeoutMs",
    ]);
    assert.equal(requests[0].requestOptions.maxRetries, 0);
    assert.equal(requests[0].requestOptions.maxTokens, 17);
    await state.host.stream({ ...context, messages: [answer] }, options()).then((next) => next.result());
    assert.deepEqual(requests[1].input.messages[0], answer);
});

test("native adapter returns one terminal error event without inventing a new response", async () => {
    const answer = { ...message("error"), errorMessage: "synthetic error" };
    const { host } = fixture(async () => answer);
    const stream = await host.stream(context, options());
    const events = [];
    for await (const event of stream) {
        events.push(event);
    }

    assert.deepEqual(events, [{ type: "error", reason: "error", error: answer }]);
    assert.equal(await stream.result(), answer);
});

test("native adapter keeps cancelled and revoked requests pending until the original registry promise settles", async () => {
    for (const reason of ["abort", "revoke", "during-dispatch", "timeout"]) {
        let release;
        const original = new Promise((resolve) => {
            release = resolve;
        });
        let state;
        let signal;
        state = fixture((_model, _context, requestOptions) => {
            signal = requestOptions.signal;
            if (reason === "during-dispatch") {
                state.revoke();
            }

            return original;
        });
        const controller = new AbortController();
        const stream = await state.host.stream(context, {
            ...options(),
            signal: controller.signal,
            timeoutMs: reason === "timeout" ? 1 : 4000,
        });
        let settled = false;
        const pending = stream.result().finally(() => {
            settled = true;
        });
        const rejection = assert.rejects(pending, /cancelled|lease/u);
        if (reason === "abort") {
            controller.abort();
        } else if (reason === "revoke") {
            state.revoke();
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(settled, false, reason);
        if (["abort", "timeout"].includes(reason)) {
            assert.equal(signal.aborted, true);
        }

        release(message());
        await rejection;
        assert.equal(state.calls(), 1);
    }
});

test("native adapter checks the final response size and structure after registry settlement", async () => {
    for (const answer of [
        { ...message(), content: [{ type: "text", text: "x".repeat(256 * 1024) }] },
        { role: "user", content: [], stopReason: "stop" },
        { ...message(), stopReason: "unexpected" },
    ]) {
        const { host } = fixture(async () => answer);
        const stream = await host.stream(context, options());
        await assert.rejects(stream.result(), /256 KiB|invalid delegation response/u);
    }

    const { host } = fixture(async () => {
        throw new Error("registry failed");
    });
    const stream = await host.stream(context, options());
    await assert.rejects(stream.result(), /registry failed/u);
});

test("real Pi registry retains configured routing and OAuth without parent inference hooks", (testContext) => {
    const result = runPiFixture(path.resolve("tests/fixtures/delegation-provider-harness.ts"));
    if (result.unavailable) {
        testContext.skip(result.error?.message ?? "Pi is unavailable");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const marker = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/u)
        .find((line) => line.startsWith("DELEGATION_FIXTURE="));
    assert.ok(marker, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(JSON.parse(marker.slice("DELEGATION_FIXTURE=".length)), {
        sdkVersion: "0.84.4",
        nativeRegistry: true,
        oauth: true,
        parentHooksExcluded: true,
    });
});

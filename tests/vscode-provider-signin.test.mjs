import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
    providerAuthFailure,
    providerLabel,
    providerSignInMessage,
    providerSignInState,
    signInInstructions,
} = require("../vscode/src/provider-signin.js");
const { getWebviewHtml } = require("../vscode/src/webview.js");

const webviewOptions = {
    cspSource: "https://specpi-test.vscode-cdn.net",
    scriptUri: "https://specpi-test.vscode-cdn.net/media/chat.js",
    styleUri: "https://specpi-test.vscode-cdn.net/media/chat.css",
    nonce: "specpi-test-nonce-1234567890",
};

test("Pi's missing-credential reports are recognised, including its unnamed provider", () => {
    assert.deepEqual(providerAuthFailure("No API key found for anthropic."), { provider: "anthropic" });
    assert.deepEqual(
        providerAuthFailure(new Error("No API key found for cloudflare-ai-gateway.\n\nUse /login to log in. See:")),
        { provider: "cloudflare-ai-gateway" },
    );
    // Pi substitutes this phrase when the selected model has no known provider.
    assert.deepEqual(providerAuthFailure("No API key found for the selected model."), { provider: "" });
    assert.deepEqual(providerAuthFailure("No models available. Use /login"), { provider: "" });
    assert.deepEqual(providerAuthFailure("No model selected.\n\nUse /login"), { provider: "" });
});

test("unrelated failures are not treated as a missing credential", () => {
    for (const value of [
        undefined,
        null,
        "",
        "Pi exited. Reconnect to continue.",
        new Error("The API key found for anthropic was rejected."),
        new Error("429 rate limit exceeded"),
    ]) {
        assert.equal(providerAuthFailure(value), null);
    }
});

test("provider labels drop Pi's placeholders and stay bounded", () => {
    assert.equal(providerLabel("anthropic"), "anthropic");
    assert.equal(providerLabel("  openai  "), "openai");
    assert.equal(providerLabel("unknown"), "");
    assert.equal(providerLabel("the selected model"), "");
    assert.equal(providerLabel(""), "");
    assert.equal(providerLabel(undefined), "");
    assert.equal(providerLabel(42), "");
    assert.equal(providerLabel("x".repeat(500)).length, 64);
});

test("sign-in guidance replaces Pi's /login text and local documentation paths", () => {
    for (const message of [providerSignInMessage("anthropic"), providerSignInMessage("")]) {
        assert.equal(message.includes("/login"), false);
        assert.equal(message.includes(".md"), false);
        assert.match(message, /Sign in to/u);
    }

    assert.match(providerSignInMessage("anthropic"), /no credential for anthropic/u);
    assert.match(providerSignInMessage("unknown"), /no provider credential/u);
});

test("the panel appears only once Pi has reported a catalogue with no usable provider", () => {
    const unknown = { id: "unknown", name: "unknown", provider: "unknown" };
    const usable = { id: "claude-opus-4-8", name: "Opus", provider: "anthropic" };

    // Pi answers an unauthenticated session with an empty catalogue and this model.
    assert.match(providerSignInState({ catalogLoaded: true, models: [], model: unknown }).message, /no provider/u);
    assert.equal(providerSignInState({ catalogLoaded: true, models: [], model: undefined }) === undefined, false);

    // A disconnected chat has an empty catalogue for an unrelated reason.
    assert.equal(providerSignInState({ catalogLoaded: false, models: [], model: unknown }), undefined);
    assert.equal(providerSignInState(), undefined);
    assert.equal(providerSignInState({ catalogLoaded: true, models: [usable], model: usable }), undefined);
    assert.equal(providerSignInState({ catalogLoaded: true, models: [], model: usable }), undefined);
    assert.equal(providerSignInState({ catalogLoaded: true, models: undefined, model: unknown }), undefined);

    // A named send failure keeps the panel up even after the connection drops.
    const failed = providerSignInState({ catalogLoaded: false, models: [usable], failure: { provider: "openai" } });
    assert.equal(failed.provider, "openai");
    assert.match(failed.message, /openai/u);
});

test("a starting connection does not flash the sign-in panel before the catalogue lands", () => {
    // Between spawning Pi and its first get_available_models answer the catalogue is empty
    // because nothing has asked yet. Reading that as a missing credential put the panel on
    // screen for the whole startup, then took it away again once the models arrived.
    assert.equal(providerSignInState({ catalogLoaded: false, models: [], model: undefined }), undefined);
    assert.equal(providerSignInState({ catalogLoaded: false, models: [], model: { provider: "unknown" } }), undefined);
});

test("sign-in instructions name the terminal and the command Pi expects", () => {
    const text = signInInstructions("SpecPi Chat · Pi sign-in");
    assert.match(text, /SpecPi Chat · Pi sign-in/u);
    assert.match(text, /\/login/u);
    assert.match(text, /never sees the credential/u);
});

test("the webview ships a sign-in panel wired to the extension", () => {
    const html = getWebviewHtml(webviewOptions);
    assert.match(html, /<section id="provider-signin"[^>]*hidden>/u);
    assert.match(html, /<button id="provider-signin-start"/u);
    assert.match(html, /<button id="provider-signin-reload"/u);
    assert.match(html, /never reads, stores, or sends your provider credentials/u);

    const script = require("node:fs").readFileSync(new URL("../vscode/media/chat.js", import.meta.url), "utf8");
    assert.match(script, /"provider-signin-start": "signIn"/u);
    assert.match(script, /"provider-signin-reload": "reloadProviders"/u);
});

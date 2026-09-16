"use strict";

// Pi owns provider credentials. Chat never reads, writes, or stores them: it
// recognises Pi's own "no usable provider" reports and hands sign-in back to
// Pi running in a terminal. Pi resolves its model catalogue once at startup,
// so a credential stored after launch is only visible after a restart.

const UNKNOWN_PROVIDER = "unknown";
const UNKNOWN_MODEL = "the selected model";
const MAX_PROVIDER_CHARS = 64;
const MISSING_KEY = /No API key found for ([^.\n]{1,200})\./u;
const MISSING_CATALOG = /No models? available|No model selected/u;

/** A displayable provider id, or "" when Pi could not name one. */
function providerLabel(value) {
    if (typeof value !== "string") {
        return "";
    }

    const name = value.trim();
    if (!name || name === UNKNOWN_PROVIDER || name === UNKNOWN_MODEL) {
        return "";
    }

    return name.slice(0, MAX_PROVIDER_CHARS);
}

/**
 * Recognise Pi's missing-credential errors. Pi's own text embeds absolute
 * documentation paths and points at /login, which only its terminal runs, so
 * the caller replaces the message rather than displaying it.
 */
function providerAuthFailure(error) {
    const text = typeof error === "string" ? error : String(error?.message ?? "");
    if (!text) {
        return null;
    }

    const missingKey = MISSING_KEY.exec(text);
    if (missingKey) {
        return { provider: providerLabel(missingKey[1]) };
    }

    return MISSING_CATALOG.test(text) ? { provider: "" } : null;
}

function providerSignInMessage(provider) {
    const target = providerLabel(provider);
    if (target) {
        return (
            `Pi has no credential for ${target}, so this message was not sent. ` +
            "Sign in to that provider in Pi, then reload so Chat picks it up."
        );
    }

    return (
        "Pi has no provider credential, so no models are available and messages cannot be sent. " +
        "Sign in to a provider in Pi, then reload so Chat picks it up."
    );
}

/**
 * The sign-in panel's state, or undefined when a provider is usable.
 * A send that failed on a named provider reports that provider. An empty
 * catalogue means "no credential" only once Pi has actually answered with its
 * models: `catalogLoaded` is false while a connection is still starting, where
 * the catalogue is empty because nothing has asked for it yet. Reading that
 * window as a missing credential flashes the panel over every startup.
 */
function providerSignInState({ catalogLoaded = false, models, model, failure } = {}) {
    if (failure) {
        return { provider: failure.provider, message: providerSignInMessage(failure.provider) };
    }

    if (catalogLoaded && Array.isArray(models) && models.length === 0 && !providerLabel(model?.provider)) {
        return { provider: "", message: providerSignInMessage("") };
    }

    return undefined;
}

function signInInstructions(terminalName) {
    return (
        `Pi is starting in the "${terminalName}" terminal. Type /login there, choose your provider, ` +
        "and finish its browser or API key prompt. Close that terminal when you are done and Chat reloads Pi " +
        "so the new provider appears. Chat never sees the credential."
    );
}

module.exports = {
    providerAuthFailure,
    providerLabel,
    providerSignInMessage,
    providerSignInState,
    signInInstructions,
};

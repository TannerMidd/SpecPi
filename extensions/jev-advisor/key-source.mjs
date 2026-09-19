// Where the Jev layer's key comes from, and the one place that answers it.
//
// This file exists because the layer used to answer it wrongly. Jev read `OPENROUTER_API_KEY` from
// the environment and nothing else, while Pi itself had already resolved an OpenRouter credential
// for the session through `/login openrouter` and stored it where every other provider stores one.
// The result was a layer that reported "key: missing" to someone who had a working OpenRouter key
// sitting in `auth.json`, with no interface anywhere that would have explained the gap. Reading the
// credential Pi already has is not a new integration; it is stopping an old one from opting out.
//
// Pi's documented resolution order (docs/providers.md, "Resolution Order") is:
//
//   1. the `--api-key` CLI flag        -- Pi's own, scoped to Pi's model calls, not ours
//   2. `<agent-dir>/auth.json`         -- what `/login` writes
//   3. the provider environment variable
//   4. custom provider keys in models.json
//
// We implement 2 then 3, in that order, so a person who has logged in once is served and a person
// who exports the variable is still served. Step 1 is Pi's alone and step 4 describes provider
// catalogue entries the decisions endpoint has no equivalent of.
//
// Two rules hold everywhere below.
//
// The key is returned by exactly one function, `resolveKey()`, and callers pass it straight to a
// request header. Nothing else here ever sees the value: `keySource()` returns a label so status
// output, the Chat panel and the ledger can say where a key came from without any of them being a
// place a key could leak from. That split is the whole reason this is a module rather than two
// lines in client.mjs.
//
// And a missing or malformed credential is never an error. Every failure path returns undefined,
// the caller reports `unavailable("no-key")`, and the harness does what it did before the layer
// existed. A credential store that can throw is a credential store that can take the session down.

import fs from "node:fs";
import path from "node:path";
import { agentDirectory } from "./config.mjs";

/** Pi's provider id for OpenRouter, from the provider table in its own docs. */
export const OPENROUTER_PROVIDER = "openrouter";

// auth.json holds one entry per provider and OAuth entries carry refresh and access tokens, so it
// is meaningfully larger than the 4 KiB settings bound. This is still small enough that anything
// above it was not written by Pi, and reading it is what stops a hostile or corrupt file from
// costing the session a multi-megabyte synchronous read on the tool path.
const MAX_AUTH_BYTES = 256 * 1024;

export function authPath() {
    return path.join(agentDirectory(), "auth.json");
}

/**
 * Pi strips a BOM before parsing and so do we: an auth.json written by a Windows editor parses for
 * Pi and would otherwise fail here, which is the worst kind of difference -- the key works for
 * every model call and appears missing to this layer alone.
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The parsed store, cached against the file's own identity.
 *
 * `ask()` resolves a key per request and retention fires on every large read-only tool result, so an
 * uncached read put a synchronous stat, read and JSON parse of up to 256 KiB on the tool path inside
 * a 1500 ms latency budget -- where it used to be one `process.env` lookup. The cache key is the
 * file's size and modification time, so `/login` writing a new credential mid-session invalidates it
 * on the next call rather than being masked until restart, which a plain memo would have done.
 */
let parsedStore = { key: "", data: undefined };

function readStore(file, stat) {
    const identity = `${stat.mtimeMs}:${stat.size}:${file}`;
    if (parsedStore.key === identity) {
        return parsedStore.data;
    }

    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(stripBom(text));
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    parsedStore = { key: identity, data };

    return data;
}

/**
 * The raw stored entry for one provider, or undefined. Deliberately not exported: an entry is a
 * credential, and the only thing outside this file that needs one is the request header.
 */
function storedCredential(providerId) {
    try {
        const file = authPath();
        // `stat`, not `lstat`: a symlinked auth.json has to resolve, because dotfile managers like
        // chezmoi and stow routinely link it into a managed directory. Refusing links here would
        // recreate the exact divergence this module was written to remove -- Pi resolves the
        // credential and every model call works, while this layer alone reports "key: none found"
        // and gives no way to tell that from a missing key.
        //
        // config.mjs refuses links on its own files for a reason that does not apply here: those
        // are writes, where a link can redirect a trusted write somewhere it was not meant to go.
        // This is a bounded read of a file Pi owns, so an unsupported shape reads as "no credential"
        // rather than throwing. It is not our file to have opinions about.
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat || !stat.isFile() || stat.size > MAX_AUTH_BYTES) {
            return undefined;
        }

        return readStore(file, stat)?.[providerId];
    } catch {
        return undefined;
    }
}

/**
 * An api_key credential's key, or undefined for anything else.
 *
 * An `oauth` entry is ignored rather than unwrapped. Pi refreshes OAuth tokens inside a lock in its
 * own credential store, and a second process reading an access token out of the file would be
 * reading a value that may already have been rotated -- and would be doing it without the lock.
 * OpenRouter's own login mints a durable `api_key` anyway, so the case this skips is not the case
 * anyone reaches.
 */
function apiKeyOf(credential) {
    if (!credential || typeof credential !== "object" || credential.type !== "api_key") {
        return undefined;
    }

    const key = credential.key;

    return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

function environmentKey(name) {
    const value = process.env[name];

    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Whether the credential store is consulted at all.
 *
 * `JEV_KEY_SOURCE=environment` restricts resolution to the environment variables. That exists for
 * this repository's own scripts, and it is a correctness fix rather than a convenience: the
 * calibration and triage runs load a key from the gitignored `evals/.env` and AGENTS.md promises
 * "a variable already set in the shell always wins". Once `auth.json` was consulted first, those
 * runs would silently bill a developer's personal `/login openrouter` account instead of the eval
 * key, and `--probe` would verify a key the run then did not use.
 */
function environmentOnly() {
    return process.env.JEV_KEY_SOURCE === "environment";
}

/**
 * Jev is reached through OpenRouter by default: that is where it is published, it is what
 * specpi-jev-guard already uses, and an OpenRouter key (`sk-or-...`) is rejected by the direct
 * TypeSafe API with a bare 401. `JEV_BACKEND=typesafe` selects the direct API for a TypeSafe key.
 *
 * It lives here rather than in client.mjs because everything below has to bind it. A parameter
 * defaulting to the string "openrouter" is not a binding: re-exporting such a function under a name
 * whose previous version read the backend itself silently rebound every no-arg caller to the wrong
 * route, which is how `keyPresent()` came to report a key that `resolveKey()` would not return.
 */
export function backend() {
    return process.env.JEV_BACKEND === "typesafe" ? "typesafe" : "openrouter";
}

export function keyEnvName(route = backend()) {
    return route === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
}

/**
 * Every place a key for this backend could come from, in the order they are consulted, each with
 * whether it currently holds one. This is what `/jev status`, `specpi doctor` and the Chat panel
 * render, and it carries labels only -- never a key, not even a truncated one.
 *
 * The list is returned whole rather than filtered to the winner because "which of these do I need
 * to fix" is the question someone with no key is actually asking, and a bare "missing" has never
 * answered it.
 */
export function keySources(route = backend()) {
    const variable = keyEnvName(route);
    const sources = [];
    // Only the OpenRouter route has a provider entry to read: `auth.json` is keyed by Pi provider
    // id, and the direct TypeSafe API is not one of Pi's providers.
    if (route !== "typesafe" && !environmentOnly()) {
        sources.push({
            name: "auth.json",
            label: `Pi credential store (${OPENROUTER_PROVIDER})`,
            detail: "/login openrouter",
            present: apiKeyOf(storedCredential(OPENROUTER_PROVIDER)) !== undefined,
        });
    }

    sources.push({
        name: variable,
        label: `${variable} in the environment`,
        detail: `export ${variable}=...`,
        present: environmentKey(variable) !== undefined,
    });

    // Accepted on the OpenRouter route so an env file predating the OpenRouter default keeps
    // working. Listed last because it is a compatibility path, and listed at all because a person
    // whose key is only here should be able to see that that is why it still works.
    if (route !== "typesafe") {
        sources.push({
            name: "TYPESAFE_API_KEY",
            label: "TYPESAFE_API_KEY in the environment (legacy)",
            detail: "export TYPESAFE_API_KEY=...",
            present: environmentKey("TYPESAFE_API_KEY") !== undefined,
        });
    }

    return sources;
}

/** The name of the source a key would be taken from, or undefined when there is none. */
export function keySource(route = backend()) {
    return keySources(route).find((source) => source.present)?.name;
}

/**
 * The key itself. The only function here that returns one, and the only caller is the request
 * header in client.mjs.
 */
export function resolveKey(route = backend()) {
    if (route !== "typesafe" && !environmentOnly()) {
        const stored = apiKeyOf(storedCredential(OPENROUTER_PROVIDER));
        if (stored) {
            return stored;
        }
    }

    return environmentKey(keyEnvName(route)) ?? (route !== "typesafe" ? environmentKey("TYPESAFE_API_KEY") : undefined);
}

/**
 * Whether any source holds a key. Callers only ever ask this; the client reads the value itself at
 * call time, so a key never has to exist inside a structure that something might log or serialize.
 */
export function keyPresent(route = backend()) {
    return keySources(route).some((source) => source.present);
}

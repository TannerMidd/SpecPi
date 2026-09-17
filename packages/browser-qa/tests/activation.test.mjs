import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadStartupActivation, saveStartupActivation, settingsPath, syncActiveTools } from "../src/activation.mjs";

function agentDir(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-activation-")));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(() => {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previous;
        }

        fs.rmSync(directory, { recursive: true, force: true });
    });

    return directory;
}

test("the tools stay withdrawn until a preference explicitly offers them", (t) => {
    agentDir(t);
    // Fourteen schemas ride on every request, so an absent or malformed preference is off.
    assert.equal(loadStartupActivation(), false);
    saveStartupActivation(true);
    assert.equal(loadStartupActivation(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(), "utf8")), { schema: 1, startupActivation: true });
    saveStartupActivation(false);
    assert.equal(loadStartupActivation(), false);
    assert.throws(() => saveStartupActivation("yes"), /must be on or off/);
});

test("an unreadable, foreign-schema or linked preference reads as withdrawn", (t) => {
    agentDir(t);
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const content of ["{", '{"schema":2,"startupActivation":true}', '{"startupActivation":true}', "[]"]) {
        fs.writeFileSync(file, content);
        assert.equal(loadStartupActivation(), false, content);
    }

    fs.rmSync(file);
    const target = path.join(path.dirname(file), "target.json");
    fs.writeFileSync(target, '{"schema":1,"startupActivation":true}');
    fs.linkSync(target, file);
    assert.equal(loadStartupActivation(), false, "a hardlinked preference must not be trusted");
});

test("activation adds and removes only this package's tools", () => {
    let active = ["read", "write", "delegate"];
    const pi = {
        getActiveTools: () => [...active],
        setActiveTools: (names) => {
            active = [...names];
        },
    };
    const owned = ["browser_open", "browser_close"];

    syncActiveTools(pi, owned, true);
    assert.deepEqual(active, ["read", "write", "delegate", "browser_open", "browser_close"]);

    // Idempotent: a second call must not duplicate or reorder anything.
    const before = [...active];
    syncActiveTools(pi, owned, true);
    assert.deepEqual(active, before);

    syncActiveTools(pi, owned, false);
    assert.deepEqual(active, ["read", "write", "delegate"], "another package's tools survive a withdrawal");

    syncActiveTools(pi, owned, false);
    assert.deepEqual(active, ["read", "write", "delegate"]);
});

test("a host without the active-tool API is left alone", () => {
    assert.doesNotThrow(() => syncActiveTools({}, ["browser_open"], true));
    assert.doesNotThrow(() => syncActiveTools(undefined, ["browser_open"], false));
});

test("no tool carries active-only prompt metadata, so activation cannot rebuild the system prompt", () => {
    // These tools ship withdrawn and are activated mid-session. Pi rebuilds the system prompt
    // when an activated tool carries promptSnippet or promptGuidelines, and that rebuild
    // invalidates the provider's cached prefix even where deferred tool schemas are supported.
    // Guidance for these tools belongs in their description, which travels with the schema.
    const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.equal(source.includes("promptSnippet"), false);
    assert.equal(source.includes("promptGuidelines"), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jevConfig = require("../vscode/media/jev-config.js");
const { TARGETS, jevPath, loadPackageSettings, savePackageSettings } = require("../vscode/src/package-settings.js");

function withAgentDir(run) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-jev-chat-")));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
        return run(dir);
    } finally {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previous;
        }

        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("Chat edits the file the advisor actually reads", () => {
    withAgentDir((dir) => {
        // extensions/jev-advisor/config.mjs resolves <agent-dir>/specpi/jev/settings.json. Editing
        // any other path would leave a panel that saves successfully and changes nothing.
        assert.equal(jevPath({ workspace: dir }), path.join(dir, "specpi", "jev", "settings.json"));
        assert.ok(TARGETS.includes("jevLayer"));
    });
});

test("an absent settings file reads as the whole layer off", () => {
    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        assert.equal(loaded.exists, false);
        const flat = JSON.parse(loaded.text);
        for (const key of ["master", "startup", "guardEnabled", "guardStartup", ...jevConfig.SYSTEMS]) {
            assert.equal(flat[key], false, `${key} should default off`);
        }
    });
});

test("the nested disk shape survives a round trip through the flat form", () => {
    const stored = {
        schema: 1,
        master: true,
        startup: false,
        systems: { retention: true, compaction: false, gap: true, sources: false },
        callBudgetPerSession: 16,
        guard: { enabled: false, startup: true },
    };
    assert.deepEqual(jevConfig.toStored(jevConfig.fromStored(stored)), stored);
});

test("saving writes the nested shape the extension expects, not the flat one", () => {
    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        const draft = { ...JSON.parse(loaded.text), master: true, retention: true, guardEnabled: true };
        savePackageSettings(loaded, `${JSON.stringify(draft)}\n`);
        const written = JSON.parse(fs.readFileSync(jevPath({ workspace: dir }), "utf8"));
        // The advisor collapses any shape without schema 1 to all-off, so the marker is load-bearing.
        assert.equal(written.schema, 1);
        assert.equal(written.master, true);
        assert.deepEqual(written.systems, { retention: true, compaction: false, gap: false, sources: false });
        assert.deepEqual(written.guard, { enabled: true, startup: false });
        assert.ok(!("retention" in written), "the flat key must not leak onto disk");
        assert.ok(!("guardEnabled" in written), "the flat key must not leak onto disk");
    });
});

test("a draft the advisor would reject is refused before it reaches disk", () => {
    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        for (const bad of [{ master: "yes" }, { callBudgetPerSession: 999 }, { callBudgetPerSession: -1 }]) {
            assert.throws(() => savePackageSettings(loaded, `${JSON.stringify({ ...bad })}\n`));
        }

        assert.equal(fs.existsSync(jevPath({ workspace: dir })), false, "a refused draft must not create the file");
    });
});

test("an unknown key is reported rather than silently carried", () => {
    // The advisor reads an unrecognised shape as all-off, so keeping a stray key would turn the
    // layer off later without anything having said so.
    const result = jevConfig.validate(JSON.stringify({ master: true, leftover: 1 }));
    assert.deepEqual(result.unknown, ["leftover"]);
});

test("every switch the panel offers exists in the advisor's own schema", async () => {
    const { defaultSettings, SYSTEM_NAMES } = await import("../extensions/jev-advisor/config.mjs");
    const defaults = defaultSettings();
    const stored = jevConfig.toStored(jevConfig.fromStored(defaults));
    assert.deepEqual(stored, defaults, "the panel's default must equal the advisor's default");
    assert.deepEqual([...jevConfig.SYSTEMS], [...SYSTEM_NAMES], "the panel must offer exactly the advisor's systems");
});

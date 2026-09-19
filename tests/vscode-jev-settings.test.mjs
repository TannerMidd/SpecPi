import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jevConfig = require("../vscode/media/jev-config.js");
const {
    TARGETS,
    jevPath,
    jevUsagePath,
    loadPackageSettings,
    savePackageSettings,
} = require("../vscode/src/package-settings.js");
const { packageSettingsState } = require("../vscode/src/package-state.js");

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
    // Built from the live system list rather than spelled out, so adding a system is a change in
    // one place instead of a test that fails for the wrong reason.
    const on = new Set(["retention", "gap"]);
    const stored = {
        schema: 2,
        master: true,
        startup: false,
        systems: Object.fromEntries(jevConfig.SYSTEMS.map((name) => [name, on.has(name)])),
        budgets: { ...jevConfig.DEFAULT_BUDGETS, total: 16, retention: 8 },
        progressNudge: "message",
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
        // The advisor collapses any shape it does not recognise to all-off, so the marker is
        // load-bearing: a panel still writing schema 1 would produce a file the advisor migrates
        // rather than reads, and a panel writing schema 3 would switch the whole layer off.
        assert.equal(written.schema, 2);
        assert.equal(written.master, true);
        assert.deepEqual(
            written.systems,
            Object.fromEntries(jevConfig.SYSTEMS.map((name) => [name, name === "retention"])),
        );
        assert.equal(written.progressNudge, "notify", "the layer must not default to steering the model");
        assert.deepEqual(written.guard, { enabled: true, startup: false });
        assert.deepEqual(written.budgets, jevConfig.DEFAULT_BUDGETS);
        for (const key of ["retention", "guardEnabled", "budgetTotal", "budgetRetention"]) {
            assert.ok(!(key in written), `the flat key ${key} must not leak onto disk`);
        }
    });
});

test("a draft the advisor would reject is refused before it reaches disk", () => {
    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        const bad = [
            { master: "yes" },
            // The total and the per-system ceilings differ, and the form has to enforce each one
            // against its own limit rather than against whichever is larger.
            { budgetTotal: jevConfig.MAX_TOTAL_BUDGET + 1 },
            { budgetTotal: -1 },
            { budgetRetention: jevConfig.MAX_CALL_BUDGET + 1 },
            { budgetRetention: 1.5 },
            // An unrecognised nudge mode reads as "notify" in the advisor, so accepting it here
            // would quietly give the person a weaker setting than the one they typed.
            { progressNudge: "shout" },
            { progressNudge: true },
        ];
        for (const draft of bad) {
            assert.throws(() => savePackageSettings(loaded, `${JSON.stringify(draft)}\n`));
        }

        assert.equal(fs.existsSync(jevPath({ workspace: dir })), false, "a refused draft must not create the file");
    });
});

test("a schema 1 file is migrated rather than read as the layer switched off", async () => {
    // The advisor's rule is that an unrecognised shape collapses to all-off. Applying that to our
    // own previous version would silently disable the layer for anyone who had turned it on, so
    // schema 1 is migrated: the one shared ceiling becomes the total.
    //
    // The panel and the advisor migrate in two files that cannot import each other, so this asserts
    // they agree on the same bytes rather than that each is separately plausible. A panel that
    // showed defaults here would overwrite the user's ceiling the first time they pressed save.
    const { loadSettings } = await import("../extensions/jev-advisor/config.mjs");
    for (const [budget, expected] of [
        [6, 6],
        // Schema 1 read 0 as "no ceiling", so it must not migrate into "no calls". Written as the
        // constant rather than the number it happens to be, because the ceiling is meant to move.
        [0, jevConfig.MAX_TOTAL_BUDGET],
    ]) {
        withAgentDir((dir) => {
            const file = jevPath({ workspace: dir });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(
                file,
                `${JSON.stringify({
                    schema: 1,
                    master: true,
                    startup: true,
                    systems: { retention: true, compaction: false, gap: false, sources: false },
                    callBudgetPerSession: budget,
                    guard: { enabled: false, startup: false },
                })}\n`,
            );
            const flat = JSON.parse(loadPackageSettings("jevLayer", { workspace: dir }).text);
            assert.equal(flat.master, true, "a migrated file must not read as the layer off");
            assert.equal(flat.retention, true);
            assert.equal(flat.budgetTotal, expected, "the old shared ceiling becomes the new total");
            assert.deepEqual(jevConfig.toStored(flat), loadSettings(), "the panel and the advisor must migrate alike");
        });
    }
});

test("the panel can be opened at all", async () => {
    // It could not. The panel shipped complete -- fields, validation, a guarded write -- and with
    // no entry in PACKAGES, so every attempt to open it was refused as a package that is not
    // installed, and the file it writes could only be edited by hand.
    assert.equal(packageSettingsState({ commands: [{ name: "jev" }] }).targets.includes("jevLayer"), true);
    assert.equal(packageSettingsState({ commands: [{ name: "websearch" }] }).targets.includes("jevLayer"), false);

    // And the select has to offer it, or a reachable target is still unreachable.
    const { getWebviewHtml } = await import("../vscode/src/webview.js");
    const html = getWebviewHtml({
        cspSource: "https://specpi-test.vscode-cdn.net",
        nonce: "nonce",
        styleUri: "https://specpi-test.vscode-cdn.net/media/chat.css",
        scriptUri: "https://specpi-test.vscode-cdn.net/media/chat.js",
        codiconsUri: "https://specpi-test.vscode-cdn.net/media/codicon.css",
    });
    assert.match(html, /<option value="jevLayer"/u);
});

test("Chat reports the advisor's own call counts, and never writes them", () => {
    withAgentDir((dir) => {
        const usage = jevUsagePath({ workspace: dir });
        fs.mkdirSync(path.dirname(usage), { recursive: true });
        fs.writeFileSync(
            usage,
            `${JSON.stringify({
                schema: 1,
                session: "a-session",
                startedAt: "2026-09-18T10:00:00.000Z",
                updatedAt: "2026-09-18T10:20:00.000Z",
                active: true,
                calls: 7,
                budgets: { ...jevConfig.DEFAULT_BUDGETS },
                systems: { retention: { calls: 5, applied: 0, failed: 0, savedBytes: 0 } },
            })}\n`,
        );

        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        assert.equal(loaded.usage.calls, 7);
        assert.equal(loaded.usage.active, true);
        assert.equal(loaded.usage.systems.retention.calls, 5);
        // A system that never ran is still a row, so "is retention doing anything" has an answer.
        assert.deepEqual(loaded.usage.systems.progress, { calls: 0, applied: 0, failed: 0, savedBytes: 0 });

        const rows = jevConfig.usageRows(loaded.usage);
        assert.equal(rows.length, jevConfig.SYSTEMS.length + 1);
        assert.deepEqual(rows[0], {
            name: "total",
            label: "All systems",
            calls: 7,
            budget: jevConfig.DEFAULT_BUDGETS.total,
            applied: null,
        });

        // Saving settings must leave the counter exactly as the advisor wrote it. The panel reports
        // spend; it cannot edit the evidence.
        const before = fs.readFileSync(usage, "utf8");
        savePackageSettings(loaded, `${JSON.stringify({ ...JSON.parse(loaded.text), master: true })}\n`);
        assert.equal(fs.readFileSync(usage, "utf8"), before);
    });
});

test("a count Chat cannot read leaves the panel working", () => {
    // A budget display is a convenience beside the switches. Every way it can fail has to end in
    // the panel opening without it, never in the panel refusing to open.
    withAgentDir((dir) => {
        const usage = jevUsagePath({ workspace: dir });
        fs.mkdirSync(path.dirname(usage), { recursive: true });
        for (const text of ["", "{", "null", JSON.stringify({ schema: 2, calls: 9 })]) {
            fs.writeFileSync(usage, text);
            assert.equal(loadPackageSettings("jevLayer", { workspace: dir }).usage, undefined, `readable: ${text}`);
        }

        fs.rmSync(usage);
        assert.equal(loadPackageSettings("jevLayer", { workspace: dir }).usage, undefined);
    });
});

test("an unknown key is reported rather than silently carried", () => {
    // The advisor reads an unrecognised shape as all-off, so keeping a stray key would turn the
    // layer off later without anything having said so.
    const result = jevConfig.validate(JSON.stringify({ master: true, leftover: 1 }));
    assert.deepEqual(result.unknown, ["leftover"]);
});

test("every switch the panel offers exists in the advisor's own schema", async () => {
    const { DEFAULT_BUDGETS, defaultSettings, SYSTEM_NAMES } = await import("../extensions/jev-advisor/config.mjs");
    const defaults = defaultSettings();
    const stored = jevConfig.toStored(jevConfig.fromStored(defaults));
    assert.deepEqual(stored, defaults, "the panel's default must equal the advisor's default");
    assert.deepEqual([...jevConfig.SYSTEMS], [...SYSTEM_NAMES], "the panel must offer exactly the advisor's systems");
    // Two copies of the same numbers, in two packages that cannot import each other. If they drift,
    // every save from the panel writes a budget change nobody asked for.
    assert.deepEqual(jevConfig.DEFAULT_BUDGETS, { ...DEFAULT_BUDGETS });
    for (const name of SYSTEM_NAMES) {
        assert.ok(
            jevConfig.fields.some(([key]) => key === jevConfig.BUDGET_KEYS[name]),
            `${name} has no budget field`,
        );
    }
});

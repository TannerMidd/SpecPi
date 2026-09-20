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
    jevKeyStatus,
    jevPath,
    jevUsagePath,
    loadPackageSettings,
    savePackageSettings,
} = require("../vscode/src/package-settings.js");
const { packageSettingsState } = require("../vscode/src/package-state.js");

// The same shape as the advisor suite's helper, and fixed the same way for the same reason. This
// copy was left behind when that one was corrected, which is its own lesson: the bug was duplicated
// before it was understood, so fixing the file where it fired left an identical landmine in the
// file that gained the most new tests -- including ones that write fixture credential stores.
//
// A `try/finally` around a bare `return run(dir)` stops isolating at an async callback's first
// `await`: the cleanup restores PI_CODING_AGENT_DIR and deletes the temporary directory there, and
// the rest of the body runs against the developer's real `~/.pi/agent`. Every callback here is
// synchronous today, so this was latent rather than firing -- but "latent" is not a property anyone
// can see when adding the one `await` that arms it.
function withAgentDir(run) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-jev-chat-")));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const restore = () => {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previous;
        }

        fs.rmSync(dir, { recursive: true, force: true });
    };

    let result;
    try {
        result = run(dir);
    } catch (error) {
        restore();
        throw error;
    }

    if (!result || typeof result.then !== "function") {
        restore();

        return result;
    }

    return result.then(
        (value) => {
            restore();

            return value;
        },
        (error) => {
            restore();
            throw error;
        },
    );
}

/**
 * Write a fixture credential store, and never outside the temporary directory.
 *
 * The advisor suite's equivalent guard exists because the missing one cost a real developer every
 * provider they had logged into. These tests write `auth.json` too, so they carry the same check
 * rather than relying on the helper above staying correct.
 */
function writeAuth(directory, entries) {
    const file = path.join(directory, "auth.json");
    if (!file.startsWith(fs.realpathSync.native(os.tmpdir()))) {
        throw new Error(`Refusing to write a fixture auth.json outside the temporary directory: ${file}`);
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);

    return file;
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
        for (const key of ["enabled", ...jevConfig.SYSTEMS]) {
            assert.equal(flat[key], false, `${key} should default off`);
        }
    });
});

test("the nested disk shape survives a round trip through the flat form", () => {
    // Built from the live system list rather than spelled out, so adding a system is a change in
    // one place instead of a test that fails for the wrong reason.
    const on = new Set(["retention", "gap"]);
    const stored = {
        schema: 5,
        master: true,
        startup: true,
        systems: Object.fromEntries(jevConfig.SYSTEMS.map((name) => [name, on.has(name)])),
        budgets: { ...jevConfig.DEFAULT_BUDGETS, total: 16, retention: 8 },
        progressNudge: "message",
    };
    assert.deepEqual(jevConfig.toStored(jevConfig.fromStored(stored)), stored);
});

test("a file that is on but not at startup is read as off, because that is what it does", () => {
    // `master` and `startup` are two keys for one intention and the advisor requires both: its
    // session_start zeroes a stored master whenever startup is false. So `master: true,
    // startup: false` is not a layer that is on -- it is a layer that never runs, and a panel
    // showing it as enabled would be describing behaviour no session will ever have. The round
    // trip is deliberately not the identity here: it resolves the pair to what the advisor does.
    const stored = {
        schema: 5,
        master: true,
        startup: false,
        systems: Object.fromEntries(jevConfig.SYSTEMS.map((name) => [name, true])),
        budgets: { ...jevConfig.DEFAULT_BUDGETS },
        progressNudge: "notify",
    };
    const flat = jevConfig.fromStored(stored);
    assert.equal(flat.enabled, false);
    const round = jevConfig.toStored(flat);
    assert.equal(round.master, false);
    assert.equal(round.startup, false);

    // And the pair is always written together, so the checkbox means the same thing next session.
    const on = jevConfig.toStored({ ...flat, enabled: true });
    assert.equal(on.master, true);
    assert.equal(on.startup, true);

    // The mirror case, which `/jev startup on` used to produce: startup set, master never written.
    // session_start keeps a stored master only when startup is true, and here there is none to
    // keep, so this file also describes a layer that never runs. Reading it as off is correct, and
    // normalising both keys costs nothing because there was no working preference to preserve.
    const mirrored = jevConfig.fromStored({ ...stored, master: false, startup: true });
    assert.equal(mirrored.enabled, false);
    assert.equal(jevConfig.toStored(mirrored).startup, false);
});

test("saving writes the nested shape the extension expects, not the flat one", () => {
    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        const draft = { ...JSON.parse(loaded.text), enabled: true, retention: true };
        savePackageSettings(loaded, `${JSON.stringify(draft)}\n`);
        const written = JSON.parse(fs.readFileSync(jevPath({ workspace: dir }), "utf8"));
        // The advisor collapses any shape it does not recognise to all-off, so the marker is
        // load-bearing: a panel still writing schema 1 would produce a file the advisor migrates
        // rather than reads, and a panel writing a schema the advisor retired would switch the
        // whole layer off.
        assert.equal(written.schema, 5);
        assert.equal(written.master, true);
        assert.equal(written.startup, true, "the panel writes a preference, so on means on next session too");
        assert.deepEqual(
            written.systems,
            Object.fromEntries(jevConfig.SYSTEMS.map((name) => [name, name === "retention"])),
        );
        assert.equal(written.progressNudge, "notify", "the layer must not default to steering the model");
        assert.ok(!("guard" in written.systems), "the guard is a package, not one of the systems");
        assert.ok(!("guard" in written), "and the layer's file records nothing about it");
        assert.deepEqual(written.budgets, jevConfig.DEFAULT_BUDGETS);
        for (const key of ["enabled", "retention", "budgetTotal", "budgetRetention"]) {
            assert.ok(!(key in written), `the flat key ${key} must not leak onto disk`);
        }
    });
});

test("a draft the advisor would reject is refused before it reaches disk", () => {
    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        const bad = [
            { enabled: "yes" },
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
                    systems: { retention: true, gap: false, sources: false },
                    callBudgetPerSession: budget,
                    guard: { enabled: false, startup: false },
                })}\n`,
            );
            const flat = JSON.parse(loadPackageSettings("jevLayer", { workspace: dir }).text);
            assert.equal(flat.enabled, true, "a migrated file must not read as the layer off");
            assert.equal(flat.retention, true);
            assert.equal(flat.budgetTotal, expected, "the old shared ceiling becomes the new total");
            assert.deepEqual(jevConfig.toStored(flat), loadSettings(), "the panel and the advisor must migrate alike");
        });
    }
});

test("both older guard shapes are dropped, by the panel and the advisor alike", async () => {
    // Schema 2 kept a `guard` pair and schema 3 kept `systems.guard`. Neither decided whether the
    // guard actually ran -- the package's own file does -- so schema 4 kept neither, and the
    // panel has to agree with the advisor about that or a save would reintroduce a key the
    // advisor no longer reads. Schema 5 drops compaction on the same terms, so the shapes below
    // carry it and assert it is gone too.
    const { loadSettings } = await import("../extensions/jev-advisor/config.mjs");
    const shapes = [
        {
            schema: 2,
            master: true,
            startup: true,
            systems: { retention: true, compaction: true },
            budgets: { total: 6, compaction: 48 },
            guard: { enabled: true, startup: true },
        },
        {
            schema: 3,
            master: true,
            startup: true,
            systems: { retention: true, guard: true, compaction: true },
            budgets: { total: 6, compaction: 48 },
        },
    ];

    for (const stored of shapes) {
        withAgentDir((dir) => {
            const file = jevPath({ workspace: dir });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify(stored)}\n`);

            const advisor = loadSettings();
            assert.ok(!("guard" in advisor), `schema ${stored.schema}: the advisor kept a guard key`);

            const loaded = loadPackageSettings("jevLayer", { workspace: dir });
            const flat = JSON.parse(loaded.text);
            assert.ok(!("guard" in flat), `schema ${stored.schema}: the guard is not a panel field`);

            savePackageSettings(loaded, `${JSON.stringify(flat)}\n`);
            const written = JSON.parse(fs.readFileSync(file, "utf8"));
            assert.equal(written.schema, 5);
            assert.ok(!("guard" in written), `schema ${stored.schema}: the panel wrote a guard key back`);
            assert.ok(!("guard" in written.systems), `schema ${stored.schema}: the retired system key lingers`);
            assert.ok(
                !("compaction" in written.systems),
                `schema ${stored.schema}: the withdrawn compaction switch lingers`,
            );
            assert.ok(
                !("compaction" in written.budgets),
                `schema ${stored.schema}: the withdrawn compaction budget lingers`,
            );
            assert.equal(written.budgets.total, 6, "the rest of the file is still the user's");
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
        savePackageSettings(
            loaded,
            `${JSON.stringify({ ...JSON.parse(loaded.text), enabled: true, retention: true })}\n`,
        );
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
    const result = jevConfig.validate(JSON.stringify({ enabled: true, retention: true, leftover: 1 }));
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

test("the panel names the key source instead of asking for a key it cannot hold", () => {
    // "There is no interface for the API key" was accurate: the panel held no credential and said
    // nothing about where one comes from, so a person with a working key had no way to learn the
    // layer was ignoring it. The fix is reporting, not a key field -- Pi already owns the store.
    withAgentDir((dir) => {
        const env = {};
        fs.mkdirSync(dir, { recursive: true });

        const empty = jevKeyStatus({ settingsFile: jevPath({ workspace: dir }), env });
        assert.equal(empty.active, undefined);
        assert.deepEqual(
            empty.sources.map((item) => [item.name, item.present]),
            [
                ["auth.json", false],
                ["OPENROUTER_API_KEY", false],
                ["TYPESAFE_API_KEY", false],
            ],
        );

        writeAuth(dir, { openrouter: { type: "api_key", key: "openrouter-fixture-x" } });
        assert.equal(jevKeyStatus({ settingsFile: jevPath({ workspace: dir }), env }).active, "auth.json");

        // The store wins, matching the advisor and matching Pi's own documented order.
        assert.equal(
            jevKeyStatus({
                settingsFile: jevPath({ workspace: dir }),
                env: { OPENROUTER_API_KEY: "openrouter-fixture-y" },
            }).active,
            "auth.json",
        );
    });
});

test("the panel never learns a key, only whether there is one", () => {
    withAgentDir((dir) => {
        fs.mkdirSync(dir, { recursive: true });
        writeAuth(dir, { openrouter: { type: "api_key", key: "openrouter-fixture-secret" } });
        const status = jevKeyStatus({
            settingsFile: jevPath({ workspace: dir }),
            env: { OPENROUTER_API_KEY: "openrouter-fixture-other" },
        });
        assert.ok(
            !JSON.stringify(status).includes("openrouter-fixture-"),
            "a key must not reach the webview through the status it renders",
        );
        for (const item of status.sources) {
            assert.equal(typeof item.present, "boolean");
        }
    });
});

test("no source is singled out for the command guard, because it reads all of them", () => {
    // Before guard 0.3.0 the package read OPENROUTER_API_KEY alone, so one row was marked as the
    // only one it could see. It resolves the same credential in the same order as the advisor now,
    // so a mark on any row would be telling someone with a stored credential that the guard cannot
    // use it.
    withAgentDir((dir) => {
        const { sources } = jevKeyStatus({ settingsFile: jevPath({ workspace: dir }), env: {} });
        assert.ok(sources.length > 1);
        for (const item of sources) {
            assert.ok(!("guard" in item), `${item.name} still carries a guard-only flag`);
            assert.ok(!/only this|invisible to the guard/i.test(item.detail), `${item.name}: stale guard wording`);
        }
    });
});

test("an unreadable credential store leaves the panel working", () => {
    // Same rule as the usage counter beside it: this is a report, and no way it can fail may stop
    // the switches opening.
    withAgentDir((dir) => {
        fs.mkdirSync(dir, { recursive: true });
        for (const text of ["", "{", "null", "[]", JSON.stringify({ openrouter: { type: "oauth" } })]) {
            fs.writeFileSync(path.join(dir, "auth.json"), text);
            assert.equal(
                jevKeyStatus({ settingsFile: jevPath({ workspace: dir }), env: {} }).active,
                undefined,
                `readable: ${text}`,
            );
        }

        assert.ok(loadPackageSettings("jevLayer", { workspace: dir }).key);
    });
});

test("switching the layer on in the form switches its systems on with it", () => {
    // A layer enabled with every system off runs and does nothing, which is the state people kept
    // arriving at. The form fills them in on the off-to-on transition so the boxes visibly tick,
    // rather than a save quietly rewriting seven settings nobody touched.
    const off = jevConfig.fromStored({});
    const { config, note } = jevConfig.couple({ ...off, enabled: true }, off);
    assert.ok(note, "the panel has to say that it did this");
    for (const name of jevConfig.SYSTEMS) {
        assert.equal(config[name], true, `${name} should come on with the layer`);
    }

    // A deliberate subset is a choice, and toggling the layer must not hand back the rest.
    const chosen = { ...off, enabled: true, retention: true };
    assert.deepEqual(jevConfig.couple(chosen, off).config, chosen);
    assert.equal(jevConfig.couple(chosen, off).note, "");

    // Nothing happens while the layer is off.
    assert.deepEqual(jevConfig.couple({ ...off, enabled: false }, off).config, { ...off, enabled: false });

    // Unticking the last system in a working file is a decision, not a broken file, and this test
    // used to assert the opposite -- that every system was switched back on, with a note describing
    // a file that never existed. `/jev disable` reads the same situation as "switch the layer off",
    // so the panel does too.
    const alreadyOn = { ...off, enabled: true, gap: true };
    const emptied = jevConfig.couple({ ...alreadyOn, gap: false }, alreadyOn);
    assert.ok(emptied.note);
    assert.equal(emptied.config.enabled, false, "the layer goes off rather than the systems coming back");
    for (const name of jevConfig.SYSTEMS) {
        assert.equal(emptied.config[name], false, `${name} must stay as the person left it`);
    }

    // A file that arrives already dead is still repaired: nobody chose that state in front of us.
    const dead = { ...off, enabled: true };
    const repaired = jevConfig.couple(dead, dead);
    assert.ok(repaired.note);
    assert.equal(repaired.config.enabled, true);
    for (const name of jevConfig.SYSTEMS) {
        assert.equal(repaired.config[name], true, `${name} should be filled in for a broken file`);
    }
});

test("a layer that is on with nothing to run cannot be saved, but can still be opened", () => {
    // The rule lives in the host, not the webview validator. As a validation error it fired while
    // merely opening a file in this state -- the exact file the panel exists to repair -- so the
    // panel rendered red with Save disabled before anything was touched.
    const off = jevConfig.fromStored({});
    const dead = { ...off, enabled: true };
    assert.equal(jevConfig.deadLayer(dead), true);
    assert.equal(jevConfig.deadLayer({ ...dead, retention: true }), false);
    assert.equal(jevConfig.deadLayer(off), false, "the shipped default is off, not dead");

    // Opening must never throw, whatever the file says.
    jevConfig.validate(JSON.stringify(dead));
    jevConfig.validate(JSON.stringify(off));

    // And the form repairs it rather than leaving it stuck.
    const repaired = jevConfig.couple(dead, dead);
    assert.ok(repaired.note, "a loaded dead file must be repaired and the repair announced");
    for (const name of jevConfig.SYSTEMS) {
        assert.equal(repaired.config[name], true);
    }

    withAgentDir((dir) => {
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        assert.throws(
            () =>
                savePackageSettings(
                    loaded,
                    `${JSON.stringify(dead)}
`,
                ),
            /runs and does nothing/u,
            "the host is the authority the JSON textarea cannot bypass",
        );
    });
});

test("the key report follows the backend the advisor will actually use", () => {
    // auth.json is keyed by Pi provider id and TypeSafe is not one of Pi's providers, so naming the
    // credential store on that route would promise a key the advisor never reads.
    withAgentDir((dir) => {
        const settingsFile = jevPath({ workspace: dir });
        writeAuth(dir, { openrouter: { type: "api_key", key: "openrouter-fixture-x" } });

        const openrouter = jevKeyStatus({ settingsFile, env: {} });
        assert.equal(openrouter.active, "auth.json");

        const typesafe = jevKeyStatus({ settingsFile, env: { JEV_BACKEND: "typesafe" } });
        assert.equal(typesafe.active, undefined, "the store holds nothing for the direct API");
        assert.deepEqual(
            typesafe.sources.map((item) => item.name),
            ["TYPESAFE_API_KEY"],
        );

        // And the repository's own environment-only mode hides a source it will not consult.
        const evalRun = jevKeyStatus({ settingsFile, env: { JEV_KEY_SOURCE: "environment" } });
        assert.ok(!evalRun.sources.some((item) => item.name === "auth.json"));
    });
});

test("the key report resolves the same directory before and after a save", () => {
    // loadJev passed its options through and saveJev called the reporter with none, so a
    // workspace-relative PI_CODING_AGENT_DIR made pressing Save flip a working panel to "No key
    // anywhere" -- a false report caused only by saving. Both now derive it from the settings file.
    withAgentDir((dir) => {
        writeAuth(dir, { openrouter: { type: "api_key", key: "openrouter-fixture-x" } });
        const loaded = loadPackageSettings("jevLayer", { workspace: dir });
        assert.equal(loaded.key.active, "auth.json");

        const draft = { ...JSON.parse(loaded.text), enabled: true, retention: true };
        const saved = savePackageSettings(loaded, `${JSON.stringify(draft)}\n`);
        assert.equal(saved.key.active, "auth.json", "saving must not change where the key is looked for");
    });
});

test("Chat's key report and the advisor's resolver agree about every source", async () => {
    // Two readers of one contract, kept in step by a test rather than by hope. Chat cannot import
    // the advisor's ESM resolver from a synchronous CommonJS host, and the resolver returns keys
    // which the webview host has no business holding -- so the copy stays and this pins it, the same
    // way DEFAULT_BUDGETS is pinned to the advisor's own defaults above.
    const { keySources } = await import("../extensions/jev-advisor/key-source.mjs");
    const previous = { ...process.env };
    withAgentDir((dir) => {
        const settingsFile = jevPath({ workspace: dir });
        for (const env of [
            {},
            { OPENROUTER_API_KEY: "openrouter-fixture-x" },
            { TYPESAFE_API_KEY: "ts" },
            { JEV_BACKEND: "typesafe" },
            { JEV_BACKEND: "typesafe", TYPESAFE_API_KEY: "ts" },
            { JEV_KEY_SOURCE: "environment" },
        ]) {
            for (const withStore of [false, true]) {
                if (withStore) {
                    writeAuth(dir, { openrouter: { type: "api_key", key: "openrouter-fixture-stored" } });
                } else {
                    fs.rmSync(path.join(dir, "auth.json"), { force: true });
                }

                for (const name of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_BACKEND", "JEV_KEY_SOURCE"]) {
                    delete process.env[name];
                }

                Object.assign(process.env, env);
                const mine = jevKeyStatus({ settingsFile, env: process.env });
                const theirs = keySources();
                assert.deepEqual(
                    mine.sources.map((item) => [item.name, item.present]),
                    theirs.map((item) => [item.name, item.present]),
                    `sources disagree for ${JSON.stringify(env)} (store: ${withStore})`,
                );
                assert.equal(
                    mine.active,
                    theirs.find((item) => item.present)?.name,
                    `active source disagrees for ${JSON.stringify(env)} (store: ${withStore})`,
                );
            }
        }
    });

    for (const name of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_BACKEND", "JEV_KEY_SOURCE"]) {
        if (previous[name] === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = previous[name];
        }
    }
});

test("Chat and the advisor agree about a symlinked credential store", () => {
    // The parity test above never created a link, so it passed while the two readers disagreed:
    // one used lstat and refused links, the other used stat and followed them. A dotfile manager
    // linking auth.json is the case key-source.mjs cites, and the result was /jev status reporting
    // "in use from auth.json" beside a panel reporting "No key anywhere".
    withAgentDir((dir) => {
        const real = path.join(dir, "managed-auth.json");
        fs.writeFileSync(real, JSON.stringify({ openrouter: { type: "api_key", key: "openrouter-fixture-linked" } }));
        try {
            fs.symlinkSync(real, path.join(dir, "auth.json"));
        } catch {
            return; // Unprivileged Windows cannot create links; the assertion below needs one.
        }

        const status = jevKeyStatus({ settingsFile: jevPath({ workspace: dir }), env: {} });
        assert.equal(status.active, "auth.json", "a linked store must read the same as a plain one");
    });
});

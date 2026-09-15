import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
    agentDirectory,
    modelThinkingOverride,
    readDefaults,
    saveDefaults,
    settingsPath,
} = require("../vscode/src/pi-defaults.js");

// Pi reports the levels it supports at runtime; these are the ones Pi ships
// with today. Tests that care about an unfamiliar level pass their own list.
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const save = (snapshot, patch, levels = LEVELS) => saveDefaults(snapshot, patch, levels);

function fixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-defaults-")));
    const home = path.join(directory, "home");
    const agent = path.join(home, ".pi", "agent");
    fs.mkdirSync(agent, { recursive: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = { env: {}, home };
    const read = () => readDefaults(options);
    const settingsFile = settingsPath(options);

    return { directory, home, agent, options, read, settingsFile };
}

function writeSettings(file, text) {
    fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
}

test("agent directory resolution follows PI_CODING_AGENT_DIR including home-relative forms", () => {
    const home = os.tmpdir();
    assert.equal(agentDirectory({ env: {}, home }), path.join(home, ".pi", "agent"));
    const custom = path.join(home, "custom-agent");
    assert.equal(agentDirectory({ env: { PI_CODING_AGENT_DIR: custom }, home }), path.resolve(custom));
    assert.equal(agentDirectory({ env: { PI_CODING_AGENT_DIR: "~" }, home }), home);
    assert.equal(agentDirectory({ env: { PI_CODING_AGENT_DIR: "~/agent" }, home }), path.join(home, "agent"));
    assert.equal(settingsPath({ env: {}, home }), path.join(home, ".pi", "agent", "settings.json"));
});

test("saving defaults on a missing settings file creates it with only the documented keys", (t) => {
    const { read, settingsFile } = fixture(t);
    const snapshot = read();
    assert.equal(snapshot.exists, false);
    assert.deepEqual(snapshot.settings, {});

    const saved = save(snapshot, { defaultProvider: "anthropic", defaultModel: "claude-sonnet" });
    assert.equal(saved.exists, true);
    assert.equal(saved.changed, true);
    assert.equal(saved.backup, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet",
    });
});

test("model and thinking defaults merge in place and preserve unrelated keys and their order", (t) => {
    const { read, settingsFile } = fixture(t);
    const original = JSON.stringify(
        {
            theme: "dark",
            packages: ["pi-skills"],
            defaultThinkingLevel: "low",
            compaction: { reserveTokens: 16384 },
        },
        null,
        2,
    );
    writeSettings(settingsFile, original);
    const saved = save(read(), { defaultProvider: "openai", defaultModel: "gpt-5.2" });
    const text = fs.readFileSync(settingsFile, "utf8");

    assert.deepEqual(JSON.parse(text), {
        theme: "dark",
        packages: ["pi-skills"],
        defaultThinkingLevel: "low",
        compaction: { reserveTokens: 16384 },
        defaultProvider: "openai",
        defaultModel: "gpt-5.2",
    });
    assert.ok(text.startsWith('{\n  "theme"'), "unrelated keys keep their leading positions");
    assert.match(String(saved.backup), /\.bak$/u);
    assert.equal(fs.readFileSync(saved.backup, "utf8"), original, "the backup holds the replaced content");

    const thinking = save(read(), { defaultThinkingLevel: "max" });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), {
        theme: "dark",
        packages: ["pi-skills"],
        defaultThinkingLevel: "max",
        compaction: { reserveTokens: 16384 },
        defaultProvider: "openai",
        defaultModel: "gpt-5.2",
    });
    assert.equal(thinking.changed, true);
});

test("an identical save reports no change and writes nothing new", (t) => {
    const { read, settingsFile } = fixture(t);
    writeSettings(settingsFile, JSON.stringify({ defaultThinkingLevel: "high" }, null, 2));
    const before = fs.statSync(settingsFile).mtimeMs;
    const saved = save(read(), { defaultThinkingLevel: "high" });

    assert.equal(saved.changed, false);
    assert.equal(fs.statSync(settingsFile).mtimeMs, before);
});

test("a settings file saved with a BOM still parses and saves", (t) => {
    const { read, settingsFile } = fixture(t);
    writeSettings(settingsFile, `﻿${JSON.stringify({ theme: "dark" }, null, 2)}`);
    const snapshot = read();
    assert.deepEqual(snapshot.settings, { theme: "dark" });

    const saved = save(snapshot, { defaultThinkingLevel: "high" });
    assert.equal(saved.changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), {
        theme: "dark",
        defaultThinkingLevel: "high",
    });
});

test("a file that already holds the pinned value is left alone whatever its formatting", (t) => {
    const { read, settingsFile } = fixture(t);
    // Four-space indentation and a trailing newline: Pi's own writer and any
    // human editor produce text that differs byte-for-byte from ours.
    writeSettings(
        settingsFile,
        `${JSON.stringify({ defaultThinkingLevel: "high" }, null, 4)}
`,
    );
    const before = fs.readFileSync(settingsFile, "utf8");
    const saved = save(read(), { defaultThinkingLevel: "high" });

    assert.equal(saved.changed, false);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), before, "the file was not reformatted");
    assert.deepEqual(
        fs.readdirSync(path.dirname(settingsFile)).filter((name) => name.endsWith(".bak")),
        [],
        "no backup was left behind for a save that changed nothing",
    );
});

test("thinking levels are validated against what Pi reports, not a hard-coded list", (t) => {
    const { read, settingsFile } = fixture(t);
    writeSettings(settingsFile, JSON.stringify({ theme: "dark" }, null, 2));

    // A level Pi has added is accepted once Pi reports it.
    const saved = save(read(), { defaultThinkingLevel: "ultra" }, ["off", "ultra"]);
    assert.equal(saved.settings.defaultThinkingLevel, "ultra");

    // A level Pi does not report is refused even though Pi ships it today.
    assert.throws(() => save(read(), { defaultThinkingLevel: "high" }, ["off", "ultra"]), /must be one of/u);
    assert.throws(() => save(read(), { defaultThinkingLevel: "high" }, []), /report its thinking levels/u);
});

test("a relative PI_CODING_AGENT_DIR resolves against the workspace, the way Pi resolves it", () => {
    const home = os.tmpdir();
    const workspace = path.join(home, "workspace");
    assert.equal(
        agentDirectory({ env: { PI_CODING_AGENT_DIR: ".pi-agent" }, home, workspace }),
        path.join(workspace, ".pi-agent"),
    );
    assert.throws(
        () => agentDirectory({ env: { PI_CODING_AGENT_DIR: ".pi-agent" }, home }),
        /Open a workspace folder/u,
    );
});

test("per-model thinking overrides set, keep other models, and remove cleanly when empty", (t) => {
    const { read, settingsFile } = fixture(t);
    save(read(), {
        modelThinkingLevel: { provider: "anthropic", modelId: "claude-sonnet", level: "xhigh" },
    });
    save(read(), {
        modelThinkingLevel: { provider: "openai", modelId: "gpt-5.2", level: "low" },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).modelThinkingLevels, {
        "anthropic/claude-sonnet": "xhigh",
        "openai/gpt-5.2": "low",
    });
    assert.equal(modelThinkingOverride(read().settings, "anthropic", "claude-sonnet"), "xhigh");
    assert.equal(modelThinkingOverride(read().settings, "anthropic", "unknown"), undefined);
    assert.equal(modelThinkingOverride({}, "anthropic", "claude-sonnet"), undefined);

    save(read(), {
        modelThinkingLevel: { provider: "openai", modelId: "gpt-5.2", level: null },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).modelThinkingLevels, {
        "anthropic/claude-sonnet": "xhigh",
    });

    save(read(), {
        modelThinkingLevel: { provider: "anthropic", modelId: "claude-sonnet", level: null },
    });
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(Object.hasOwn(settings, "modelThinkingLevels"), false, "empty maps are removed like Pi removes them");
});

test("invalid patches and malformed files are rejected without writing", (t) => {
    const { read, settingsFile } = fixture(t);
    writeSettings(settingsFile, JSON.stringify({ theme: "dark" }, null, 2));
    const snapshot = read();
    const before = fs.readFileSync(settingsFile, "utf8");

    assert.throws(() => save(snapshot, { defaultThinkingLevel: "sideways" }), /must be one of/u);
    assert.throws(() => save(snapshot, { defaultProvider: "" }), /non-empty string/u);
    assert.throws(
        () => save(snapshot, { modelThinkingLevel: { provider: "a/b", modelId: "m", level: "low" } }),
        /must not contain/u,
    );
    assert.throws(
        () => save(snapshot, { modelThinkingLevel: { provider: "a", modelId: "m", level: "nope" } }),
        /must be one of/u,
    );
    assert.throws(() => save(snapshot, {}), /Choose a startup default/u);
    assert.throws(() => save(snapshot, { modelThinkingLevel: "anthropic/claude-sonnet" }), /must be an object/u);
    assert.throws(() => modelThinkingOverride({ modelThinkingLevels: "nope" }, "a", "m"), /must be an object/u);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), before, "no bytes were written");

    writeSettings(settingsFile, "{ not json");
    assert.throws(() => read(), /not valid JSON/u);

    writeSettings(settingsFile, JSON.stringify({ theme: "dark", modelThinkingLevels: ["bad"] }, null, 2));
    assert.throws(
        () => save(read(), { modelThinkingLevel: { provider: "a", modelId: "m", level: "low" } }),
        /must be an object/u,
    );
    // A patch that does not touch the map still preserves it untouched.
    const saved = save(read(), { defaultThinkingLevel: "low" });
    assert.deepEqual(saved.settings.modelThinkingLevels, ["bad"]);
});

test("a snapshot of a file that changed on disk cannot save", (t) => {
    const { read, settingsFile } = fixture(t);
    writeSettings(settingsFile, JSON.stringify({ theme: "dark" }, null, 2));
    const snapshot = read();
    const external = JSON.stringify({ theme: "light", defaultModel: "kept" }, null, 2);
    writeSettings(settingsFile, external);

    assert.throws(() => save(snapshot, { defaultThinkingLevel: "low" }), /changed on disk/u);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), external, "the external edit survived");
});

test("directories and files that are links or wrong kinds are refused", (t) => {
    const { directory, home, agent, options } = fixture(t);
    // A linked ancestor is ordinary: a relocated macOS home or a junctioned
    // Windows profile puts one above every settings file. Resolve it and check
    // what it points at rather than refusing the save outright.
    const linkedAgent = path.join(directory, "linked-agent");
    fs.symlinkSync(agent, linkedAgent, "junction");
    writeSettings(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
    assert.deepEqual(readDefaults({ env: { PI_CODING_AGENT_DIR: linkedAgent }, home }).settings, { theme: "dark" });

    // A non-directory in the ancestry is still refused.
    const notADirectory = path.join(directory, "file-agent");
    fs.writeFileSync(notADirectory, "", "utf8");
    assert.throws(() => readDefaults({ env: { PI_CODING_AGENT_DIR: notADirectory }, home }), /real directory/u);

    const linkedFile = fixture(t);
    const target = path.join(linkedFile.agent, "elsewhere.json");
    fs.writeFileSync(target, "{}", "utf8");
    fs.rmSync(linkedFile.settingsFile, { force: true });
    fs.symlinkSync(target, linkedFile.settingsFile);
    assert.throws(linkedFile.read, /unlinked regular file/u);

    const hardLinked = fixture(t);
    writeSettings(hardLinked.settingsFile, "{}\n");
    fs.linkSync(hardLinked.settingsFile, path.join(hardLinked.agent, "alias.json"));
    assert.throws(hardLinked.read, /unlinked regular file/u);
});

test("a stale lock file blocks saving instead of corrupting settings", (t) => {
    const { read, settingsFile } = fixture(t);
    writeSettings(settingsFile, JSON.stringify({ theme: "dark" }, null, 2));
    fs.writeFileSync(`${settingsFile}.specpi-lock`, "", { mode: 0o600 });
    const snapshot = read();

    assert.throws(() => save(snapshot, { defaultThinkingLevel: "low" }), /being saved elsewhere/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { theme: "dark" });
});

for (const failure of [
    "backup-write",
    "backup-check",
    "temp-write",
    "rename",
    "verify",
    "external-edit",
    "new-file-verify",
]) {
    test(`defaults transaction survives ${failure} failure`, (t) => {
        const { read, settingsFile } = fixture(t);
        const original = Buffer.from(JSON.stringify({ theme: "dark" }, null, 2));
        if (failure !== "new-file-verify") {
            fs.writeFileSync(settingsFile, original);
        }

        const snapshot = read();
        const write = fs.writeFileSync;
        const readFileSync = fs.readFileSync;
        const readSync = fs.readSync;
        const rename = fs.renameSync;
        let replaced = false;
        let injected = false;
        const ioError = () => Object.assign(new Error("Synthetic I/O failure"), { code: "EIO" });
        t.mock.method(fs, "writeFileSync", (target, ...args) => {
            if (
                (failure === "backup-write" && String(target).endsWith(".bak")) ||
                (failure === "temp-write" && String(target).endsWith(".tmp"))
            ) {
                injected = true;
                write(target, "partial", { flag: "wx", mode: 0o600 });
                throw ioError();
            }

            return write(target, ...args);
        });
        t.mock.method(fs, "readFileSync", (target, ...args) => {
            if (failure === "backup-check" && String(target).endsWith(".bak")) {
                injected = true;

                return Buffer.from("damaged backup");
            }

            return readFileSync(target, ...args);
        });
        t.mock.method(fs, "renameSync", (from, to) => {
            if (failure === "rename") {
                injected = true;
                throw ioError();
            }

            rename(from, to);
            replaced = true;
            if (failure === "external-edit") {
                injected = true;
                write(to, '{"defaultModel":"kept"}');
            }
        });
        t.mock.method(fs, "readSync", (...args) => {
            if (["verify", "new-file-verify"].includes(failure) && replaced && !injected) {
                injected = true;
                throw ioError();
            }

            return readSync(...args);
        });
        assert.throws(
            () => save(snapshot, { defaultProvider: "openai", defaultModel: "gpt-5.2" }),
            /Synthetic I\/O|verified/u,
        );
        t.mock.restoreAll();
        assert.equal(injected, true);
        if (failure === "new-file-verify") {
            assert.equal(fs.existsSync(settingsFile), false);
        } else if (failure === "external-edit") {
            assert.equal(fs.readFileSync(settingsFile, "utf8"), '{"defaultModel":"kept"}');
        } else {
            assert.deepEqual(fs.readFileSync(settingsFile), original, "Original bytes must survive failure/rollback");
        }

        assert.equal(fs.existsSync(`${settingsFile}.specpi-lock`), false);
        assert.equal(
            fs.readdirSync(path.dirname(settingsFile)).some((name) => name.endsWith(".tmp")),
            false,
        );
        if (failure === "verify") {
            const backup = fs.readdirSync(path.dirname(settingsFile)).find((name) => name.endsWith(".bak"));
            assert.deepEqual(fs.readFileSync(path.join(path.dirname(settingsFile), backup)), original);
        }
    });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const subagents = require("../vscode/media/subagents-config.js");
const webAccess = require("../vscode/media/web-access-config.js");
const { packageSettingsState } = require("../vscode/src/package-state.js");
const {
    TARGETS,
    webAccessPath,
    targetPath,
    loadPackageSettings,
    savePackageSettings,
} = require("../vscode/src/package-settings.js");

const SECRET = "sk-synthetic-not-a-real-credential";

function fixture(t, env = {}) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-packages-")));
    const workspace = path.join(directory, "workspace");
    const home = path.join(directory, "home");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = { workspace, env, home };

    return {
        directory,
        workspace,
        home,
        options,
        load: (target) => loadPackageSettings(target, options),
        read: (target) => fs.readFileSync(targetPath(target, options), "utf8"),
    };
}

test("subagent schema types every documented key and keeps unrecognised upstream keys", () => {
    const { config, unknown } = subagents.validate(
        `{
            // Synthetic configuration; no live Pi state.
            "asyncByDefault": false,
            "fleetView": true,
            "fleetViewPlacement": "aboveEditor",
            "timeoutMs": 3600000,
            "globalConcurrencyLimit": 20,
            "waitTool": false,
            "parallel": {"maxTasks": 12, "concurrency": 6},
            "aKeyAddedUpstreamAfterThisRelease": {"nested": true}
        }`,
        subagents.EXTENSION,
    );
    assert.equal(config.fleetViewPlacement, "aboveEditor");
    assert.equal(config.waitTool, false);
    assert.deepEqual(unknown, ["aKeyAddedUpstreamAfterThisRelease"]);

    // An unknown key must not become a refusal: the package accepts keys this
    // schema has not learned yet, and blocking the save would be worse.
    assert.deepEqual(subagents.validate("{}", subagents.EXTENSION).config, {});
    assert.throws(
        () => subagents.validate('{"fleetViewPlacement": "sideways"}', subagents.EXTENSION),
        /expected one of: belowEditor, aboveEditor/u,
    );
    assert.throws(() => subagents.validate('{"timeoutMs": -1}', subagents.EXTENSION), /timeoutMs/u);
    assert.throws(() => subagents.validate('{"__proto__": {}}', subagents.EXTENSION), /__proto__/u);
    assert.throws(() => subagents.validate('{"waitTool": 5}', subagents.EXTENSION), /waitTool/u);
    assert.throws(
        () => subagents.validate('{"mainWindowRenderer": {"horizontalSpacing": 9}}', subagents.EXTENSION),
        /horizontalSpacing/u,
    );
});

test("subagent settings schema refuses a model scope the package would reject at load time", () => {
    const { config } = subagents.validate(
        '{"defaultModel": "openai/gpt-5", "defaultThinking": "high", "watchdog": {"enabled": true}}',
        subagents.SETTINGS,
    );
    assert.equal(config.defaultThinking, "high");
    assert.throws(() => subagents.validate('{"defaultThinking": "extreme"}', subagents.SETTINGS), /defaultThinking/u);

    // enforce with no allow list is rejected upstream, which would leave Pi
    // unable to launch any subagent at all.
    assert.throws(() => subagents.validate('{"modelScope": {"enforce": true}}', subagents.SETTINGS), /modelScope/u);
    assert.throws(
        () => subagents.validate('{"modelScope": {"enforce": true, "allow": [], "agents": {}}}', subagents.SETTINGS),
        /modelScope/u,
    );
    assert.doesNotThrow(() =>
        subagents.validate(
            '{"modelScope": {"enforce": true, "agents": {"worker": {"allow": ["inherit"]}}}}',
            subagents.SETTINGS,
        ),
    );
});

test("package targets resolve to the files each package actually reads", (t) => {
    const { workspace, home, options } = fixture(t);
    assert.deepEqual(TARGETS, ["subagents:extension", "subagents:global", "subagents:project", "webAccess"]);
    assert.equal(
        targetPath("subagents:extension", options),
        path.join(home, ".pi", "agent", "extensions", "subagent", "config.json"),
    );
    assert.equal(targetPath("subagents:global", options), path.join(home, ".pi", "agent", "settings.json"));
    assert.equal(targetPath("subagents:project", options), path.join(workspace, ".pi", "settings.json"));
    assert.equal(targetPath("webAccess", options), path.join(home, ".pi", "agent", "web-search.json"));
    assert.throws(() => targetPath("someOtherPackage", options), /Choose a package configuration/u);
    assert.throws(() => loadPackageSettings("someOtherPackage", options), /Choose a package configuration/u);
});

test("web access config path follows the package's own precedence", (t) => {
    const { home, directory } = fixture(t);
    const agent = path.join(directory, "explicit-agent");
    assert.equal(
        webAccessPath({ workspace: directory, env: { PI_CODING_AGENT_DIR: agent }, home }),
        path.join(agent, "web-search.json"),
    );

    const xdg = path.join(directory, "xdg");
    const xdgFile = path.join(xdg, "pi", "web-search.json");
    const legacy = path.join(home, ".pi", "web-search.json");
    // With neither file present the XDG path is the new-config target.
    assert.equal(webAccessPath({ workspace: directory, env: { XDG_CONFIG_HOME: xdg }, home }), xdgFile);

    // An existing legacy file stays usable when no XDG file exists.
    fs.writeFileSync(legacy, "{}\n");
    assert.equal(webAccessPath({ workspace: directory, env: { XDG_CONFIG_HOME: xdg }, home }), legacy);

    // An existing XDG file wins over the legacy one.
    fs.mkdirSync(path.join(xdg, "pi"), { recursive: true });
    fs.writeFileSync(xdgFile, "{}\n");
    assert.equal(webAccessPath({ workspace: directory, env: { XDG_CONFIG_HOME: xdg }, home }), xdgFile);
});

test("subagent extension config round-trips through the guarded write", (t) => {
    const { load, read, options } = fixture(t);
    const empty = load("subagents:extension");
    assert.equal(empty.exists, false);
    assert.equal(empty.text, "{}\n");

    const saved = savePackageSettings(empty, '{"asyncByDefault": false, "timeoutMs": 60000}');
    assert.equal(saved.changed, true);
    assert.equal(saved.backup, undefined);
    assert.deepEqual(JSON.parse(read("subagents:extension")), { asyncByDefault: false, timeoutMs: 60000 });

    // Saving the same meaning again neither rewrites nor backs up the file.
    const again = savePackageSettings(load("subagents:extension"), '{"asyncByDefault":false,"timeoutMs":60000}');
    assert.equal(again.changed, false);
    assert.equal(again.backup, undefined);

    // A stale snapshot must not clobber an edit made in a terminal meanwhile.
    const stale = load("subagents:extension");
    fs.writeFileSync(targetPath("subagents:extension", options), '{"asyncByDefault": true}\n');
    assert.throws(() => savePackageSettings(stale, '{"timeoutMs": 1}'), /changed on disk/u);
    assert.deepEqual(JSON.parse(read("subagents:extension")), { asyncByDefault: true });
});

test("writing the subagents block preserves every unrelated Pi setting and its order", (t) => {
    const { load, read, options } = fixture(t);
    const file = targetPath("subagents:global", options);
    fs.writeFileSync(
        file,
        JSON.stringify(
            {
                defaultModel: "keep/me",
                packages: ["npm:pi-subagents@0.67.0"],
                subagents: { defaultModel: "old" },
                theme: "dark",
            },
            null,
            2,
        ),
    );

    const snapshot = load("subagents:global");
    assert.deepEqual(JSON.parse(snapshot.text), { defaultModel: "old" });
    assert.deepEqual(snapshot.keys, ["defaultModel", "packages", "theme"]);

    savePackageSettings(snapshot, '{"defaultModel": "new/model", "disableThinking": true}');
    const written = JSON.parse(read("subagents:global"));
    assert.deepEqual(Object.keys(written), ["defaultModel", "packages", "subagents", "theme"]);
    assert.equal(written.defaultModel, "keep/me", "the Pi-level default model is not the subagents one");
    assert.deepEqual(written.packages, ["npm:pi-subagents@0.67.0"]);
    assert.deepEqual(written.subagents, { defaultModel: "new/model", disableThinking: true });

    // Clearing the block removes the key rather than leaving an empty object.
    savePackageSettings(load("subagents:global"), "{}");
    const cleared = JSON.parse(read("subagents:global"));
    assert.equal(Object.hasOwn(cleared, "subagents"), false);
    assert.deepEqual(Object.keys(cleared), ["defaultModel", "packages", "theme"]);

    // A subagents key that is not an object is a file to fix by hand, not to
    // silently overwrite.
    fs.writeFileSync(file, '{"subagents": "everything"}\n');
    assert.throws(() => load("subagents:global"), /must be an object/u);
});

test("project subagent settings need an open workspace and write beside it", (t) => {
    const { workspace, load, read } = fixture(t);
    savePackageSettings(load("subagents:project"), '{"disableBuiltins": true}');
    assert.deepEqual(JSON.parse(read("subagents:project")), { subagents: { disableBuiltins: true } });
    assert.ok(fs.existsSync(path.join(workspace, ".pi", "settings.json")));
    assert.throws(
        () => loadPackageSettings("subagents:project", { workspace: "", env: {}, home: workspace }),
        /Open a workspace folder/u,
    );
});

test("stored provider credentials never reach the webview and survive an unrelated edit", (t) => {
    const { load, read, options } = fixture(t);
    fs.writeFileSync(
        targetPath("webAccess", options),
        JSON.stringify(
            {
                openaiApiKey: SECRET,
                braveApiKey: "$BRAVE_API_KEY",
                kagiApiKey: "!/opt/secrets/read kagi",
                provider: "openai",
            },
            null,
            2,
        ),
    );

    const snapshot = load("webAccess");
    assert.equal(snapshot.text.includes(SECRET), false, "no credential may appear in what the webview receives");
    assert.equal(snapshot.text.includes("$BRAVE_API_KEY"), false);
    assert.equal(snapshot.text.includes("/opt/secrets/read"), false);
    assert.equal(JSON.parse(snapshot.text).openaiApiKey, webAccess.REDACTED);

    // Only the kind of each credential is reported, never its value.
    assert.equal(snapshot.credentials.openaiApiKey, "literal");
    assert.equal(snapshot.credentials.braveApiKey, "environment");
    assert.equal(snapshot.credentials.kagiApiKey, "command");
    assert.equal(snapshot.credentials.exaApiKey, "unset");

    // Editing something unrelated writes every untouched credential back as it
    // was, not as the marker the draft carried.
    const draft = snapshot.text.replace('"provider": "openai"', '"provider": "brave"');
    const saved = savePackageSettings(snapshot, draft);
    assert.equal(saved.changed, true);
    const written = JSON.parse(read("webAccess"));
    assert.equal(written.openaiApiKey, SECRET);
    assert.equal(written.braveApiKey, "$BRAVE_API_KEY");
    assert.equal(written.kagiApiKey, "!/opt/secrets/read kagi");
    assert.equal(written.provider, "brave");
    assert.equal(saved.text.includes(SECRET), false, "the save result is redacted too");
});

test("a credential is replaced only when retyped, removed when dropped, never invented", (t) => {
    const { load, read, options } = fixture(t);
    fs.writeFileSync(
        targetPath("webAccess", options),
        JSON.stringify({ openaiApiKey: SECRET, braveApiKey: "bsa-synthetic" }, null, 2),
    );

    savePackageSettings(load("webAccess"), '{"openaiApiKey": "sk-synthetic-replacement"}');
    const written = JSON.parse(read("webAccess"));
    assert.equal(written.openaiApiKey, "sk-synthetic-replacement");
    assert.equal(Object.hasOwn(written, "braveApiKey"), false, "a dropped credential is removed");

    // A marker with nothing behind it would otherwise be written as a
    // credential of bullet characters and silently break the provider.
    const snapshot = load("webAccess");
    assert.throws(
        () => savePackageSettings(snapshot, `{"exaApiKey": ${JSON.stringify(webAccess.REDACTED)}}`),
        /No stored credential behind the placeholder for exaApiKey/u,
    );
    assert.equal(JSON.parse(read("webAccess")).openaiApiKey, "sk-synthetic-replacement", "the refusal wrote nothing");
});

test("searxng header secrets are redacted per entry and restored by name", () => {
    const stored = {
        searxngHeaders: { "CF-Access-Client-Id": "id-synthetic", "CF-Access-Client-Secret": "secret-synthetic" },
    };
    const { config } = webAccess.redact(stored);
    assert.deepEqual(Object.keys(config.searxngHeaders), ["CF-Access-Client-Id", "CF-Access-Client-Secret"]);
    assert.equal(config.searxngHeaders["CF-Access-Client-Secret"], webAccess.REDACTED);

    // Renaming or dropping a header is honoured; an untouched one comes back.
    const restored = webAccess.restore(
        { searxngHeaders: { "CF-Access-Client-Id": "id-replaced", "CF-Access-Client-Secret": webAccess.REDACTED } },
        stored,
    );
    assert.deepEqual(restored.searxngHeaders, {
        "CF-Access-Client-Id": "id-replaced",
        "CF-Access-Client-Secret": "secret-synthetic",
    });
    assert.deepEqual(webAccess.unresolved({ searxngHeaders: { New: webAccess.REDACTED } }, stored), [
        "searxngHeaders.New",
    ]);
});

test("web access validation names the key and never echoes a value", () => {
    const { unknown } = webAccess.validate('{"provider": "brave", "aProviderAddedUpstream": 1}');
    assert.deepEqual(unknown, ["aProviderAddedUpstream"]);
    assert.throws(() => webAccess.validate('{"maxInlineContentChars": "lots"}'), /maxInlineContentChars/u);
    assert.throws(() => webAccess.validate('{"__proto__": {}}'), /__proto__/u);

    // A malformed credential must be reported without its value.
    try {
        webAccess.validate(JSON.stringify({ openaiApiKey: { nested: SECRET } }));
        assert.fail("expected a rejection");
    } catch (error) {
        assert.match(error.message, /openaiApiKey/u);
        assert.equal(error.message.includes(SECRET), false);
    }
});

test("package targets are offered only for packages the session reports", () => {
    assert.equal(packageSettingsState({ commands: [] }), undefined);
    assert.equal(packageSettingsState({}), undefined);

    const subagentsOnly = packageSettingsState({ commands: [{ name: "subagents-fleet" }] });
    assert.deepEqual(subagentsOnly.targets, ["subagents:extension", "subagents:global", "subagents:project"]);
    assert.equal(subagentsOnly.label, "Subagents");

    const both = packageSettingsState({ commands: [{ name: "subagents-guide" }, { name: "curator" }] });
    assert.deepEqual(both.targets, [...subagentsOnly.targets, "webAccess"]);
    assert.equal(both.label, "Subagents · Web access");

    const webOnly = packageSettingsState({ commands: [{ name: "websearch" }] });
    assert.deepEqual(webOnly.targets, ["webAccess"]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
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

test("package targets resolve to the files each package actually reads", (t) => {
    const { home, options } = fixture(t);
    assert.deepEqual(TARGETS, ["webAccess", "jevLayer"]);
    assert.equal(targetPath("webAccess", options), path.join(home, ".pi", "agent", "web-search.json"));
    // The advisor resolves <agent-dir>/specpi/jev/settings.json and has no XDG variant, so this
    // path is fixed rather than following web access's precedence rules.
    assert.equal(targetPath("jevLayer", options), path.join(home, ".pi", "agent", "specpi", "jev", "settings.json"));
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
    assert.equal(packageSettingsState({ commands: [{ name: "subagents-fleet" }] }), undefined);

    const webOnly = packageSettingsState({ commands: [{ name: "websearch" }] });
    assert.deepEqual(webOnly.targets, ["webAccess"]);
    assert.equal(webOnly.label, "Web access");
});

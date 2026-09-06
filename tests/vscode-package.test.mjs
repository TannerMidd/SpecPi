import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, createZip, extensionRoot, packageExtension, packageFiles } from "../vscode/scripts/package.mjs";
import { createHostEnvironment, removeHostEnvironment } from "../vscode/scripts/host-environment.mjs";

function readZip(archive) {
    const files = new Map();
    const centralOffset = archive.readUInt32LE(archive.length - 6);
    let offset = 0;
    while (offset < centralOffset) {
        assert.equal(archive.readUInt32LE(offset), 0x04034b50);
        assert.equal(archive.readUInt16LE(offset + 8), 0, "entries use the stored ZIP method");
        const size = archive.readUInt32LE(offset + 18);
        assert.equal(size, archive.readUInt32LE(offset + 22));
        const nameLength = archive.readUInt16LE(offset + 26);
        const extraLength = archive.readUInt16LE(offset + 28);
        const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
        const start = offset + 30 + nameLength + extraLength;
        const data = archive.subarray(start, start + size);
        assert.equal(crc32(data), archive.readUInt32LE(offset + 14), `CRC for ${name}`);
        assert.equal(files.has(name), false, `no duplicate archive entry ${name}`);
        files.set(name, { data, offset });
        offset = start + size;
    }

    assert.equal(offset, centralOffset);
    const centralStart = offset;
    for (const [expectedName, file] of files) {
        assert.equal(archive.readUInt32LE(offset), 0x02014b50);
        const nameLength = archive.readUInt16LE(offset + 28);
        const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
        assert.equal(name, expectedName);
        assert.equal(archive.readUInt32LE(offset + 42), file.offset);
        assert.equal(archive.readUInt32LE(offset + 20), file.data.length);
        offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
    }

    assert.equal(archive.readUInt32LE(offset), 0x06054b50);
    assert.equal(archive.readUInt16LE(offset + 8), files.size);
    assert.equal(archive.readUInt16LE(offset + 10), files.size);
    assert.equal(archive.readUInt32LE(offset + 12), offset - centralStart);
    assert.equal(offset + 22, archive.length);

    return new Map([...files].map(([name, file]) => [name, file.data]));
}

function fixture(t) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-vsix-test-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const sourceRoot = path.join(temporary, "extension");
    for (const name of packageFiles) {
        const destination = path.join(sourceRoot, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(
            destination,
            name === "package.json" ? fs.readFileSync(path.join(extensionRoot, name)) : `fixture ${name}\n`,
        );
    }

    const licensePath = path.join(temporary, "LICENSE");
    fs.writeFileSync(licensePath, "MIT License\nFixture copyright\n");

    return { sourceRoot, licensePath };
}

test("SpecPi Chat manifest provides a trusted native sidebar and application-only executable settings", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, "specpi-chat");
    assert.equal(manifest.publisher, "tannermidd");
    assert.equal(manifest.private, true);
    assert.equal(manifest.icon, "media/marketplace-icon.png");
    const icon = fs.readFileSync(path.join(extensionRoot, manifest.icon));
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(icon.readUInt32BE(16), 256);
    assert.equal(icon.readUInt32BE(20), 256);
    assert.equal(manifest.engines.vscode, "^1.96.0");
    assert.deepEqual(manifest.extensionKind, ["workspace"]);
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
    assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
    assert.equal(manifest.contributes.views["specpi-chat"][0].type, "webview");
    assert.equal(manifest.contributes.views["specpi-chat"][0].id, "specpi.chat");
    assert.deepEqual(Object.keys(manifest.contributes.configuration.properties).sort(), [
        "specpi.chat.nodePath",
        "specpi.chat.piPath",
    ]);
    for (const configuration of Object.values(manifest.contributes.configuration.properties)) {
        assert.equal(configuration.scope, "application");
        assert.equal(configuration.type, "string");
        assert.equal(configuration.default, "");
    }

    assert.equal(Object.keys(manifest.dependencies || {}).length, 0);
    const commands = manifest.contributes.commands.map((command) => command.command);
    for (const command of [
        "open",
        "new",
        "history",
        "stop",
        "attachSelection",
        "attachFile",
        "settings",
        "connect",
        "disconnect",
        "chooseWorkspace",
    ]) {
        assert.ok(commands.includes(`specpi.chat.${command}`));
    }
});

test("Chat release docs and Pages install examples name the actual VSIX and CI checks its rendering", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
    const root = path.dirname(extensionRoot);
    const basename = `specpi-chat-${manifest.version}.vsix`;
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.match(readme, /https:\/\/github\.com\/TannerMidd\/SpecPi\/blob\/main\/vscode\/README\.md/u);
    for (const name of ["vscode/README.md", "site/wiki/index.html"]) {
        const source = fs.readFileSync(path.join(root, name), "utf8");
        const references = [...source.matchAll(/specpi-chat-\d+\.\d+\.\d+(?:-[\w.-]+)?\.vsix/gu)].map(
            (match) => match[0],
        );
        assert.ok(references.length, `${name}: missing VSIX install example`);
        assert.ok(
            references.every((reference) => reference === basename),
            `${name}: stale Chat package version`,
        );
    }

    for (const name of ["site/index.html", "site/wiki/index.html", "site/single-agent/index.html"]) {
        const source = fs.readFileSync(path.join(root, name), "utf8");
        assert.ok(source.includes(`SpecPi Chat ${manifest.version}`), `${name}: stale Chat release text`);
    }

    const changelog = fs.readFileSync(path.join(extensionRoot, "CHANGELOG.md"), "utf8").replaceAll("\r\n", "\n");
    assert.ok(changelog.includes(`\n## ${manifest.version}\n`));
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/browser-tests.yml"), "utf8");
    assert.match(workflow, /run: npm --prefix vscode run test:render/u);
});

test("VSIX is deterministic, complete, and excludes every file outside the explicit allowlist", (t) => {
    const options = fixture(t);
    fs.mkdirSync(path.join(options.sourceRoot, "sessions"));
    fs.writeFileSync(path.join(options.sourceRoot, "sessions", "private.jsonl"), "must never package session content");
    fs.writeFileSync(path.join(options.sourceRoot, "auth.json"), "must never package authentication");
    const first = packageExtension(options);
    const second = packageExtension(options);
    assert.deepEqual(first.archive, second.archive);
    const files = readZip(first.archive);
    assert.deepEqual(
        [...files.keys()].sort(),
        [
            ...packageFiles.map((name) => `extension/${name}`),
            "extension/LICENSE",
            "extension.vsixmanifest",
            "[Content_Types].xml",
        ].sort(),
    );
    assert.equal(
        files
            .get("extension.vsixmanifest")
            .toString()
            .match(/Id="specpi-chat" Version="([^"]+)" Publisher="tannermidd"/)?.[1],
        JSON.parse(files.get("extension/package.json").toString()).version,
    );
    assert.match(
        files.get("extension.vsixmanifest").toString(),
        /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.96\.0"/,
    );
    assert.match(files.get("extension.vsixmanifest").toString(), /Path="extension\/package\.json"/);
    assert.match(files.get("extension.vsixmanifest").toString(), /<GalleryFlags>Public Preview<\/GalleryFlags>/);
    assert.match(
        files.get("extension.vsixmanifest").toString(),
        /<Icon>extension\/media\/marketplace-icon\.png<\/Icon>/,
    );
    assert.match(
        files.get("extension.vsixmanifest").toString(),
        /Type="Microsoft\.VisualStudio\.Services\.Icons\.Default" Path="extension\/media\/marketplace-icon\.png"/,
    );
    assert.ok(files.has("extension/media/marketplace-icon.png"));
    assert.match(files.get("[Content_Types].xml").toString(), /Extension="png" ContentType="image\/png"/);
    assert.match(files.get("[Content_Types].xml").toString(), /ContentType="image\/svg\+xml"/);
    assert.match(files.get("extension/LICENSE").toString(), /MIT License/);
    assert.equal(first.archive.includes(Buffer.from("must never package")), false);
});

test("VSIX packaging fails closed for missing files and runtime dependency drift", (t) => {
    const options = fixture(t);
    const manifestPath = path.join(options.sourceRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { unexpected: "1.0.0" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => packageExtension(options), /review the package contract/);
    delete manifest.dependencies;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.unlinkSync(path.join(options.sourceRoot, "src", "extension.js"));
    assert.throws(() => packageExtension(options), /ENOENT/);
});

test("VS Code host fixtures isolate application settings, agent state, and platform profiles", (t) => {
    const environment = createHostEnvironment();
    t.after(() => removeHostEnvironment(environment.directory));
    const settings = JSON.parse(fs.readFileSync(path.join(environment.userData, "User", "settings.json"), "utf8"));
    assert.equal(settings["specpi.chat.nodePath"], process.execPath);
    assert.equal(settings["specpi.chat.piPath"], path.join(environment.directory, "fake-pi.cjs"));
    assert.equal(
        settings["chat.disableAIFeatures"],
        true,
        "Native fixture profiles disable VS Code's unrelated built-in agent hosts",
    );
    assert.equal(environment.env.PI_CODING_AGENT_DIR, environment.agentDirectory);
    assert.equal(path.dirname(environment.agentDirectory), environment.directory);
    assert.deepEqual(fs.readdirSync(environment.agentDirectory), []);
    assert.equal(environment.env.VSCODE_PORTABLE, environment.directory);
    assert.equal(environment.env.VSCODE_IPC_HOOK_CLI, undefined);
    assert.equal(environment.env.ELECTRON_RUN_AS_NODE, undefined);
    if (process.platform === "win32") {
        for (const variable of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
            assert.equal(path.dirname(environment.env[variable]), environment.directory);
        }
    }

    assert.ok(environment.args.includes(`--user-data-dir=${environment.userData}`));
    assert.ok(environment.args.includes(`--extensions-dir=${environment.extensions}`));
    assert.ok(environment.args.includes("--disable-crash-reporter"));
    assert.ok(environment.args.includes("--use-inmemory-secretstorage"));
    assert.throws(() => removeHostEnvironment(path.join(os.tmpdir(), "unrelated-directory")), /Refusing to remove/);
});

test("VS Code host cleanup retries transient profile locks asynchronously within a fixed budget", async (t) => {
    const directory = path.join(os.tmpdir(), "specpi-vscode-host-cleanup-fixture");
    const attempts = [];
    const waits = [];
    t.mock.method(fs.promises, "rm", async (target, options) => {
        attempts.push({ target, options });
        if (attempts.length <= 2) {
            throw Object.assign(new Error("Synthetic shutdown lock"), {
                code: attempts.length === 1 ? "EPERM" : "EBUSY",
            });
        }
    });
    await removeHostEnvironment(directory, { pause: async (milliseconds) => waits.push(milliseconds) });
    assert.deepEqual(waits, [100, 200]);
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every(({ target }) => target === path.resolve(directory)));
    assert.ok(
        attempts.every(
            ({ options }) => options.recursive === true && options.force === true && options.maxRetries === 0,
        ),
    );
});

test("VS Code host cleanup exposes exhausted locks and does not retry other failures", async (t) => {
    const directory = path.join(os.tmpdir(), "specpi-vscode-host-cleanup-fixture");
    const waits = [];
    let code = "EPERM";
    let attempts = 0;
    t.mock.method(fs.promises, "rm", async () => {
        attempts += 1;
        throw Object.assign(new Error("Synthetic cleanup failure"), { code });
    });
    await assert.rejects(
        removeHostEnvironment(directory, { pause: async (milliseconds) => waits.push(milliseconds) }),
        { code: "EPERM" },
    );
    assert.equal(attempts, 8);
    assert.deepEqual(waits, [100, 200, 400, 800, 1200, 1600, 2000]);
    assert.equal(
        waits.reduce((sum, milliseconds) => sum + milliseconds, 0),
        6300,
    );
    code = "EACCES";
    attempts = 0;
    waits.length = 0;
    await assert.rejects(
        removeHostEnvironment(directory, { pause: async (milliseconds) => waits.push(milliseconds) }),
        { code: "EACCES" },
    );
    assert.equal(attempts, 1);
    assert.deepEqual(waits, []);
});

test("VS Code host cleanup revalidates the isolated root before every removal attempt", async (t) => {
    const root = os.tmpdir();
    const directory = path.join(root, "specpi-vscode-host-cleanup-fixture");
    let attempts = 0;
    t.mock.method(fs.promises, "rm", async () => {
        attempts += 1;
        throw Object.assign(new Error("Synthetic shutdown lock"), { code: "ENOTEMPTY" });
    });
    await assert.rejects(
        removeHostEnvironment(directory, {
            pause: async () => {
                t.mock.method(os, "tmpdir", () => path.join(root, "different-root"));
            },
        }),
        /Refusing to remove/u,
    );
    assert.equal(attempts, 1, "A changed temporary-root boundary must prevent the next recursive removal");
});

test("ZIP writer rejects duplicate and unsafe paths and implements standard CRC32", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
    for (const name of ["../auth.json", "/absolute", "extension/../auth.json", "extension\\file", "extension//file"]) {
        assert.throws(() => createZip([{ name, data: "example" }]), /safe relative paths/);
    }

    assert.throws(
        () =>
            createZip([
                { name: "file", data: "one" },
                { name: "file", data: "two" },
            ]),
        /safe relative paths/,
    );
});

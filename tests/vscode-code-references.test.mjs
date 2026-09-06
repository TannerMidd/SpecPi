import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import referencesModule from "../vscode/src/code-references.js";

const { parseCodeReference, resolveCodeReference } = referencesModule;

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-code-references-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, "workspace");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "source.js"), "first\nsecond\nthird\n");

    return { directory, workspace };
}

test("code references parse source lines, columns, ranges, and Windows absolute links", () => {
    const cases = [
        ["src/source.js", { path: "src/source.js", line: 1, column: 1 }],
        ["src/source.js:12", { path: "src/source.js", line: 12, column: 1 }],
        ["src/source.js:12:3", { path: "src/source.js", line: 12, column: 3 }],
        ["src/source.js:12-18", { path: "src/source.js", line: 12, column: 1, endLine: 18 }],
        ["src/source.js#L12", { path: "src/source.js", line: 12, column: 1 }],
        ["src/source.js#L12-L18", { path: "src/source.js", line: 12, column: 1, endLine: 18 }],
        ["src/source.js#L12C3-L18C9", { path: "src/source.js", line: 12, column: 3, endLine: 18 }],
        ["F:/Project/src/source.js:12", { path: "F:/Project/src/source.js", line: 12, column: 1 }],
        ["F:\\Project\\src\\source.js:12:3", { path: "F:/Project/src/source.js", line: 12, column: 3 }],
        ["/F:/My Project/source.js#L12", { path: "F:/My Project/source.js", line: 12, column: 1 }],
        ["file:///F:/My%20Project/source.js#L12", { path: "F:/My Project/source.js", line: 12, column: 1 }],
        ["file:///tmp/My%20Project/source.js:12", { path: "/tmp/My Project/source.js", line: 12, column: 1 }],
        ["src/π source.ts:7", { path: "src/π source.ts", line: 7, column: 1 }],
    ];
    for (const [reference, expected] of cases) {
        assert.deepEqual(parseCodeReference(reference), expected, reference);
    }
});

test("code references reject executable schemes, network paths, devices, streams, and hidden controls", () => {
    for (const reference of [
        "command:workbench.action.files.openFile",
        "vscode://file/F:/Project/source.js:12",
        "https://example.com/source.js#L12",
        "javascript:alert(1)",
        "data:text/plain,source.js",
        "file://server/share/source.js",
        "file://localhost/tmp/source.js",
        "file://user:password@server/share/source.js",
        "file:src/source.js",
        "//server/share/source.js:12",
        "\\\\server\\share\\source.js:12",
        "\\\\?\\F:\\Project\\source.js:12",
        "\\\\.\\pipe\\source",
        "src/source.js:secret",
        "src/source.js::$DATA",
        "src/NUL.txt:12",
        "src/COM1:12",
        "src/COM0:12",
        "src/LPT¹.txt",
        "src/CONIN$:12",
        "src/CONOUT$:12",
        "src/auth.json.",
        "src/auth.json /source.js",
        "F:source.js:12",
        "src/source\u0000.js:12",
        "src/source.js\n:12",
        "\nsource.js:12",
        "src/\u202esource.js:12",
        "src/\u2066source.js:12",
        "file:///tmp/source.js?command=anything",
        "file:///tmp/source.js#unrecognized",
        "file:///tmp/source%00.js",
        "file:///tmp/source%3Asecret.js",
        "file:///tmp/%ZZsource.js",
    ]) {
        assert.equal(parseCodeReference(reference), null, reference);
    }
});

test("code reference positions and input length are bounded before filesystem access", () => {
    for (const reference of [
        "source.js:0",
        "source.js:-1",
        "source.js:1:0",
        "source.js:1000001",
        "source.js:1:1000001",
        "source.js:12-11",
        "source.js#L0",
        "source.js#L12-L11",
        "source.js#L12C0",
        "source.js#L12-L18C0",
        "source.js#L12-L1000001",
        "source.js#L12oops",
        "source.js:99999999999999999999999999999999",
        "a".repeat(4097),
        "",
        "   ",
        null,
        { path: "source.js", line: 1 },
    ]) {
        assert.equal(parseCodeReference(reference), null);
    }

    assert.deepEqual(parseCodeReference("source.js:1000000:1000000"), {
        path: "source.js",
        line: 1000000,
        column: 1000000,
    });
});

test("code references resolve actual workspace files and retain explicit source positions", async (t) => {
    const { workspace } = await fixture(t);
    const expected = await fs.realpath(path.join(workspace, "src", "source.js"));
    for (const reference of [
        "src/source.js:2:3",
        `${path.join(workspace, "src", "source.js")}:2:3`,
        `${pathToFileURL(path.join(workspace, "src", "source.js")).href}#L2C3`,
    ]) {
        assert.deepEqual(await resolveCodeReference({ workspacePath: workspace, reference }), {
            path: expected,
            line: 2,
            column: 3,
        });
    }

    assert.deepEqual(await resolveCodeReference({ workspacePath: workspace, reference: "src/source.js#L1-L3" }), {
        path: expected,
        line: 1,
        column: 1,
        endLine: 3,
    });

    if (process.platform === "win32") {
        assert.equal(
            (
                await resolveCodeReference({
                    workspacePath: workspace,
                    reference: `/${expected.replaceAll("\\", "/")}:2`,
                })
            ).path,
            expected,
        );
    }
});

test("code references preserve literal percent filenames and decode only explicit file URLs", async (t) => {
    const { workspace } = await fixture(t);
    for (const name of ["π source.ts", "a%20b.ts", "a b.ts", "percent%source.ts"]) {
        const file = path.join(workspace, "src", name);
        await fs.writeFile(file, "source");
        const expected = await fs.realpath(file);
        assert.equal(
            (await resolveCodeReference({ workspacePath: workspace, reference: `src/${name}:2` })).path,
            expected,
        );
        assert.equal(
            (
                await resolveCodeReference({
                    workspacePath: workspace,
                    reference: `${pathToFileURL(file).href}#L2`,
                })
            ).path,
            expected,
        );
    }
});

test("code references reject missing paths, directories, and malformed requests", async (t) => {
    const { workspace } = await fixture(t);
    await assert.rejects(
        resolveCodeReference({ workspacePath: workspace, reference: "src/missing.js:2" }),
        /unavailable/u,
    );
    await assert.rejects(resolveCodeReference({ workspacePath: workspace, reference: "src:2" }), /Only regular/u);
    await assert.rejects(
        resolveCodeReference({ workspacePath: workspace, reference: "command:execute" }),
        /not a supported/u,
    );
    await assert.rejects(
        resolveCodeReference({ workspacePath: "relative", reference: "src/source.js" }),
        /local workspace/u,
    );
    await assert.rejects(resolveCodeReference({ workspacePath: null, reference: "src/source.js" }), /local workspace/u);
});

test("code references reject traversal, sibling prefixes, and encoded file URL escapes", async (t) => {
    const { directory, workspace } = await fixture(t);
    const outside = path.join(directory, "workspace-other");
    await fs.mkdir(outside);
    const file = path.join(outside, "source.js");
    await fs.writeFile(file, "outside");
    for (const reference of [
        "../workspace-other/source.js:2",
        "src/../../workspace-other/source.js:2",
        "..\\workspace-other\\source.js:2",
        `${file}:2`,
        `${pathToFileURL(workspace).href}/%2e%2e/workspace-other/source.js#L2`,
        `${pathToFileURL(workspace).href}/%2e%2e%2fworkspace-other/source.js#L2`,
        `${pathToFileURL(workspace).href}/%2e%2e%5cworkspace-other/source.js#L2`,
    ]) {
        await assert.rejects(
            resolveCodeReference({ workspacePath: workspace, reference }),
            /inside the selected workspace/u,
            reference,
        );
    }
});

test("code references reject canonical symlink escapes and hard links", async (t) => {
    const { directory, workspace } = await fixture(t);
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "source.js"), "outside");
    await fs.symlink(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
        resolveCodeReference({ workspacePath: workspace, reference: "linked/source.js:2" }),
        /outside the workspace/u,
    );
    await fs.link(path.join(outside, "source.js"), path.join(workspace, "hardlinked.js"));
    await assert.rejects(
        resolveCodeReference({ workspacePath: workspace, reference: "hardlinked.js:2" }),
        /hard links/u,
    );
});

test("code references reject sensitive paths before checking existence and recheck canonical names", async (t) => {
    const { workspace } = await fixture(t);
    for (const reference of [
        ".env:2",
        ".env.local:2",
        ".ssh/id_ed25519",
        ".aws/config",
        "credentials.json:2",
        "private-key.txt:2",
        "key.pem",
        ".npmrc",
        ".pi/agent/auth.json",
        ".pi/agent/trust.json",
        ".pi/agent/sessions/one.jsonl",
        ".pi/agent/missions/one.json",
        ".pi/agent/history.jsonl",
        "sessions/one.jsonl",
        "history.jsonl",
        `${pathToFileURL(workspace).href}/%2eenv#L2`,
    ]) {
        await assert.rejects(
            resolveCodeReference({ workspacePath: workspace, reference }),
            /cannot be opened from chat/u,
            reference,
        );
    }

    await fs.mkdir(path.join(workspace, ".aws"));
    await fs.writeFile(path.join(workspace, ".aws", "config"), "synthetic fixture");
    await fs.symlink(
        path.join(workspace, ".aws"),
        path.join(workspace, "settings"),
        process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
        resolveCodeReference({ workspacePath: workspace, reference: "settings/config:2" }),
        /cannot be opened from chat/u,
    );
});

test("code references allow ordinary source filenames resembling sensitive words", async (t) => {
    const { workspace } = await fixture(t);
    for (const name of [
        "author.js",
        "authentication.ts",
        "trustworthiness.md",
        "historyView.js",
        "sessionManager.js",
        "secretsManager.js",
    ]) {
        const file = path.join(workspace, "src", name);
        await fs.writeFile(file, "source");
        assert.equal(
            (await resolveCodeReference({ workspacePath: workspace, reference: `src/${name}:2` })).path,
            await fs.realpath(file),
        );
    }
});

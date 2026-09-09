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

    const findFiles = async () =>
        (await fs.readdir(workspace, { recursive: true })).map((name) => ({
            scheme: "file",
            fsPath: path.join(workspace, name),
        }));

    return { directory, workspace, findFiles };
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

test("chat links resolve unique shortened paths and preserve positions, with exact paths taking priority", async (t) => {
    const { workspace, findFiles } = await fixture(t);
    const nested = path.join(workspace, "src", "utils");
    await fs.mkdir(nested, { recursive: true });
    const file = path.join(nested, "helper.ts");
    await fs.writeFile(file, "source");
    const reference = "utils/helper.ts:2:3";
    await assert.rejects(resolveCodeReference({ workspacePath: workspace, reference }), /unavailable/u);
    assert.deepEqual(await resolveCodeReference({ workspacePath: workspace, reference, findFiles }), {
        path: await fs.realpath(file),
        line: 2,
        column: 3,
    });
    await fs.mkdir(path.join(workspace, "utils"));
    const exact = path.join(workspace, "utils", "helper.ts");
    await fs.writeFile(exact, "exact");
    assert.equal(
        (await resolveCodeReference({ workspacePath: workspace, reference, findFiles })).path,
        await fs.realpath(exact),
    );
});

test("shortened links reject ambiguity, spelling guesses, and missing absolute paths", async (t) => {
    const { workspace, findFiles } = await fixture(t);
    await fs.mkdir(path.join(workspace, "other"));
    await fs.writeFile(path.join(workspace, "other", "source.js"), "duplicate");
    const resolve = (reference) => resolveCodeReference({ workspacePath: workspace, reference, findFiles });
    await assert.rejects(resolve("source.js"), /multiple workspace files/u);
    await assert.rejects(resolve("sorce.js"), /No file matches/u);
    await assert.rejects(resolve(path.join(workspace, "source.js")), /unavailable/u);
    await assert.rejects(resolve("absent/../source.js"), /unavailable/u);
});

test("shortened links use a literal targeted search without walking unrelated workspace entries", async (t) => {
    const { workspace } = await fixture(t);
    const name = "helper[old],{new}.ts";
    const file = path.join(workspace, "src", name);
    await fs.writeFile(file, "source");
    t.mock.method(fs, "opendir", () => assert.fail("navigation must not walk the workspace"));
    let searched = false;
    const target = await resolveCodeReference({
        workspacePath: workspace,
        reference: `${name}:2`,
        findFiles: async (pattern, exclude) => {
            searched = true;
            assert.ok(pattern.startsWith("**/"));
            assert.ok(pattern.includes("[[]"));
            assert.ok(pattern.includes("[]]"));
            assert.ok(pattern.includes("[,][{]"));
            assert.match(exclude, /node_modules/u);

            // Unrelated results, even from an overbroad provider, do not consume
            // a fixed traversal budget or cause any metadata reads.
            return [
                ...Array.from({ length: 10_001 }, (_, index) => ({
                    scheme: "file",
                    fsPath: path.join(workspace, "unrelated", `${index}.ts`),
                })),
                { scheme: "file", fsPath: file },
            ];
        },
    });
    assert.equal(searched, true);
    assert.equal(target.path, await fs.realpath(file));
    assert.equal(target.line, 2);
});

test("shortened search results cannot select outside paths or executable and private URIs", async (t) => {
    const { workspace, directory } = await fixture(t);
    const target = path.join(workspace, "src", "source.js");
    const result = await resolveCodeReference({
        workspacePath: workspace,
        reference: "source.js",
        findFiles: async () => [
            { scheme: "file", fsPath: path.join(directory, "source.js") },
            { scheme: "command", fsPath: target },
            { scheme: "file", authority: "server", fsPath: target },
            { scheme: "file", query: "execute", fsPath: target },
            { scheme: "file", fsPath: path.join(workspace, ".aws", "source.js") },
            { scheme: "file", fsPath: target },
            { scheme: "file", fsPath: target },
        ],
    });
    assert.equal(result.path, await fs.realpath(target));
});

test("shortened links skip private trees and symlinks and still reject hard links", async (t) => {
    const { directory, workspace, findFiles } = await fixture(t);
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "outside.js"), "synthetic");
    await fs.symlink(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    for (const name of [".pi", ".git", "node_modules", ".aws"]) {
        await fs.mkdir(path.join(workspace, name));
        await fs.writeFile(path.join(workspace, name, "hidden.js"), "synthetic");
    }

    const resolve = (reference) => resolveCodeReference({ workspacePath: workspace, reference, findFiles });
    await assert.rejects(resolve("outside.js"), /No file matches/u);
    await assert.rejects(resolve("hidden.js"), /No file matches/u);
    await assert.rejects(resolve(".env"), /cannot be opened from chat/u);
    await fs.link(path.join(outside, "outside.js"), path.join(workspace, "src", "hardlinked.js"));
    await assert.rejects(resolve("hardlinked.js"), /hard links/u);
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
        ".pi/sessions/one.jsonl",
        ".pi/history.jsonl",
        "tannermidd.specpi-chat/workspaces/example/sessions/one.jsonl",
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
        "auth.ts",
        "history.js",
        "sessions.py",
        "trust.go",
        "mission.rs",
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

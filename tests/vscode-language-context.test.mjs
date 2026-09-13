import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
    collectDiagnostics,
    collectSymbolContext,
    validateLanguageAttachments,
    LANGUAGE_LIMITS,
} = require("../vscode/src/language-context.js");
const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } };
function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-language-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const uri = { scheme: "file", fsPath: path.join(root, "main.js") };
    fs.writeFileSync(uri.fsPath, "const value = 1;\n");
    const document = { uri, version: 1, isDirty: false };
    const diagnostics = [
        {
            range,
            severity: 0,
            source: "fixture",
            code: { value: "C1", target: { scheme: "command", toString: () => "command:do-not-follow" } },
            message: "Fixture error",
        },
    ];
    const calls = [];
    const vscode = {
        workspace: { textDocuments: [document] },
        languages: { getDiagnostics: () => diagnostics },
        commands: {
            async executeCommand(...args) {
                calls.push(args);

                return [{ uri, range }];
            },
        },
    };
    const editor = { document, selection: { active: { line: 0, character: 2 } } };

    return {
        root,
        uri,
        document,
        diagnostics,
        calls,
        vscode,
        editor,
        input: { workspacePath: root, uris: [uri], contextToken: "conversation-1" },
    };
}

test("diagnostics preserve source, code, severity and unsaved version while staying plain and bounded", async (t) => {
    const f = fixture(t);
    f.document.isDirty = true;
    const attachment = await collectDiagnostics(f.vscode, f.input);
    assert.match(attachment.text, /buffer version 1; unsaved yes/);
    assert.match(attachment.text, /1:2-1:4 \[error\] source="fixture" code="C1"/);
    assert.doesNotMatch(attachment.text, /command:do-not-follow/);
    assert.deepEqual(f.calls, []);
    f.diagnostics.length = 0;
    assert.match(
        (await collectDiagnostics(f.vscode, f.input)).text,
        /No diagnostics reported.*[\s\S]*do not establish a successful typecheck/,
    );
    for (let index = 0; index < 200; index += 1) {
        f.diagnostics.push({ range, severity: 1, message: "😀".repeat(4000) });
    }

    const bounded = await collectDiagnostics(f.vscode, f.input);
    assert.ok(Buffer.byteLength(bounded.text) <= LANGUAGE_LIMITS.bytes);
    assert.match(bounded.text, /Truncated: yes/);
    assert.ok((bounded.text.match(/\[warning\]/gu) ?? []).length <= 100);
    await assert.rejects(collectDiagnostics(f.vscode, { ...f.input, uris: Array(9).fill(f.uri) }), /one to eight/);
});

test("language context rejects changed buffers, closed documents, wrong tokens and file replacements", async (t) => {
    const f = fixture(t);
    const attachment = await collectDiagnostics(f.vscode, f.input);
    await validateLanguageAttachments(f.vscode, [attachment], f.root, f.input.contextToken);
    f.document.version += 1;
    await assert.rejects(
        validateLanguageAttachments(f.vscode, [attachment], f.root, f.input.contextToken),
        /buffer or file changed/,
    );
    f.document.version -= 1;
    await assert.rejects(
        validateLanguageAttachments(f.vscode, [attachment], f.root, "other-conversation"),
        /conversation changed/,
    );
    f.vscode.workspace.textDocuments = [];
    await assert.rejects(
        validateLanguageAttachments(f.vscode, [attachment], f.root, f.input.contextToken),
        /buffer or file changed/,
    );
    f.vscode.workspace.textDocuments = [f.document];
    fs.appendFileSync(f.uri.fsPath, "changed");
    await assert.rejects(
        validateLanguageAttachments(f.vscode, [attachment], f.root, f.input.contextToken),
        /buffer or file changed/,
    );
});

test("references normalize Location and LocationLink, exclude external and private URIs, and disclose missing providers", async (t) => {
    const f = fixture(t);
    const definition = await collectSymbolContext(f.vscode, { ...f.input, editor: f.editor, kind: "Definition" });
    assert.equal(f.calls[0][0], "vscode.executeDefinitionProvider");
    assert.match(definition.text, /main.js.*:1:2-1:4/);
    f.vscode.commands.executeCommand = async () => [
        { targetUri: f.uri, targetSelectionRange: range },
        { uri: { scheme: "command", fsPath: "command:do-not-follow" }, range },
        { uri: { scheme: "file", fsPath: path.join(path.dirname(f.root), "outside.js") }, range },
        { uri: { scheme: "file", fsPath: path.join(f.root, ".env") }, range },
    ];
    const attachment = await collectSymbolContext(f.vscode, { ...f.input, editor: f.editor, kind: "References" });
    assert.match(attachment.text, /Excluded locations: 3/);
    assert.doesNotMatch(attachment.text, /outside.js|\.env|command:do-not-follow/);
    f.vscode.commands.executeCommand = async () => undefined;
    assert.match(
        (await collectSymbolContext(f.vscode, { ...f.input, editor: f.editor, kind: "Definition" })).text,
        /provider may be missing/,
    );
    f.vscode.commands.executeCommand = async () => {
        f.document.version += 1;

        return [];
    };

    await assert.rejects(
        collectSymbolContext(f.vscode, { ...f.input, editor: f.editor, kind: "Definition" }),
        /buffer or file changed/,
    );
});

test("language context cannot attach a canonical escape, hard link or private file", async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, ".env"), "synthetic private fixture");
    await assert.rejects(
        collectDiagnostics(f.vscode, { ...f.input, uris: [{ scheme: "file", fsPath: path.join(f.root, ".env") }] }),
        /ordinary local/,
    );
    fs.linkSync(f.uri.fsPath, path.join(f.root, "hard.js"));
    await assert.rejects(
        collectDiagnostics(f.vscode, { ...f.input, uris: [{ scheme: "file", fsPath: path.join(f.root, "hard.js") }] }),
        /hard links/,
    );
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-language-outside-"));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    fs.writeFileSync(path.join(external, "external.js"), "external fixture");
    fs.symlinkSync(external, path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
        collectDiagnostics(f.vscode, {
            ...f.input,
            uris: [{ scheme: "file", fsPath: path.join(f.root, "alias", "external.js") }],
        }),
        /outside the workspace/,
    );
});

test("a provider deadline returns a limitation without attaching late results", async (t) => {
    const f = fixture(t);
    f.vscode.commands.executeCommand = () => new Promise(() => {});
    await assert.rejects(
        collectSymbolContext(f.vscode, { ...f.input, editor: f.editor, kind: "References" }),
        /timed out/,
    );
});

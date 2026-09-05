import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkSyntax, syntaxFiles } from "../scripts/check-syntax.mjs";

test("syntax checks discover every delegation source including its TypeScript entry", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const found = new Set(syntaxFiles(root));
    const directory = path.join(root, "extensions", "delegation");
    for (const file of fs.readdirSync(directory)) {
        assert.ok(found.has(path.join(directory, file)), `Unchecked delegation source: ${file}`);
    }

    assert.ok(found.has(path.join(directory, "index.ts")));
});

test("nested new modules are checked without a hand-maintained manifest", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-syntax-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ["scripts", "extensions", "browser-runtime", "site"]) {
        fs.mkdirSync(path.join(root, directory));
    }

    const nested = path.join(root, "extensions", "new-extension");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "index.ts"), "class Valid { constructor(public value: number) {} }\n");
    fs.writeFileSync(path.join(nested, "core.mjs"), "export const valid = true;\n");
    assert.deepEqual(checkSyntax(root), { files: 2, passed: true });
    const errors = [];
    t.mock.method(process.stderr, "write", (message) => {
        errors.push(message);

        return true;
    });
    fs.writeFileSync(path.join(nested, "new.mjs"), "export const broken = ;\n");
    assert.deepEqual(checkSyntax(root), { files: 3, passed: false });
    fs.writeFileSync(path.join(nested, "new.mjs"), "export const valid = true;\n");
    fs.writeFileSync(path.join(nested, "index.ts"), "const broken: number = ;\n");
    assert.deepEqual(checkSyntax(root), { files: 3, passed: false });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /new\.mjs/);
    assert.match(errors[1], /index\.ts/);
});

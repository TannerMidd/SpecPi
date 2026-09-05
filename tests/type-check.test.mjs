import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as core from "../extensions/browser/core.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("scoped no-emit type gate checks first-party browser files and rejects wrong API/input types", () => {
    const read = ts.readConfigFile(path.join(root, "tsconfig.browser.json"), ts.sys.readFile);
    assert.equal(read.error, undefined);
    const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    assert.deepEqual(config.errors, []);
    assert.equal(config.options.strict, true);
    assert.equal(config.options.noEmit, true);
    assert.ok(config.fileNames.some((file) => file.endsWith("/browser/index.ts")));
    const clean = ts.createProgram(config.fileNames, config.options);
    assert.deepEqual(
        ts.getPreEmitDiagnostics(clean).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")),
        [],
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-types-"));
    try {
        const file = path.join(directory, "negative.mts");
        const imported = (relative) => JSON.stringify(path.join(root, relative).replaceAll("\\", "/"));
        fs.writeFileSync(
            file,
            `import type { Page } from ${imported("node_modules/playwright/index.d.ts")};\nimport type { Static } from ${imported("node_modules/typebox/build/index.d.mts")};\nimport { PressParams } from ${imported("extensions/browser/interactions.ts")};\ndeclare const page: Page;\npage.keyboard.press(123);\nconst input: Static<typeof PressParams> = { key: 123 };\n`,
        );
        const broken = ts.createProgram([...config.fileNames, file], config.options);
        const diagnostics = ts.getPreEmitDiagnostics(broken);
        assert.deepEqual(diagnostics.map((item) => item.code).sort(), [2322, 2345]);
        let emittedFiles = 0;
        broken.emit(undefined, () => {
            emittedFiles += 1;
        });
        assert.equal(emittedFiles, 0);
        assert.deepEqual(fs.readdirSync(directory), ["negative.mts"]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("narrow browser core declarations cover every runtime export; helper behavior has separate regressions", () => {
    const source = fs.readFileSync(path.join(root, "extensions/browser/core.d.mts"), "utf8");
    const declared = [...source.matchAll(/export declare (?:const|function) (\w+)/gu)].map((match) => match[1]).sort();
    assert.deepEqual(declared, Object.keys(core).sort());
});

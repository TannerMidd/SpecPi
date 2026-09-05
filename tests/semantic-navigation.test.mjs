import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

test("assessment: existing TypeScript language service resolves aliases, references and on-disk diagnostics", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-navigation-"));
    const library = path.join(directory, "library.ts");
    const app = path.join(directory, "app.ts");
    const librarySource = "export function greet(name: string) { return name; }\n";
    const appSource =
        'import { greet as welcome } from "./library";\nwelcome("reader");\nfunction unrelated() { const greet = 1; return greet; }\n';
    fs.writeFileSync(library, librarySource);
    fs.writeFileSync(app, appSource);
    let version = 0;
    const host = {
        getScriptFileNames: () => [library, app],
        getScriptVersion: () => String(version),
        getScriptSnapshot: (file) =>
            fs.existsSync(file) ? ts.ScriptSnapshot.fromString(fs.readFileSync(file, "utf8")) : undefined,
        getCurrentDirectory: () => directory,
        getCompilationSettings: () => ({
            strict: true,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            types: [],
        }),
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
    };
    const service = ts.createLanguageService(host);
    try {
        const definitions = service.getDefinitionAtPosition(app, appSource.indexOf('welcome("'));
        assert.equal(definitions.length, 1);
        assert.equal(path.resolve(definitions[0].fileName), library);
        assert.equal(
            librarySource.slice(
                definitions[0].textSpan.start,
                definitions[0].textSpan.start + definitions[0].textSpan.length,
            ),
            "greet",
        );
        const references = service
            .findReferences(library, librarySource.indexOf("greet"))
            .flatMap((symbol) => symbol.references);
        assert.ok(
            references.some(
                (reference) =>
                    path.resolve(reference.fileName) === app &&
                    reference.textSpan.start === appSource.indexOf('welcome("'),
            ),
        );
        assert.ok(
            references.every(
                (reference) =>
                    path.resolve(reference.fileName) === library ||
                    reference.textSpan.start < appSource.indexOf("function unrelated"),
            ),
        );
        assert.deepEqual(service.getSemanticDiagnostics(app), []);
        fs.writeFileSync(app, appSource.replace('welcome("reader")', "welcome(123)"));
        version += 1;
        const diagnostics = service.getSemanticDiagnostics(app);
        assert.deepEqual(
            diagnostics.map((diagnostic) => diagnostic.code),
            [2345],
        );
        t.diagnostic(
            `Resolved one cross-file definition, ${references.length} symbol references excluding shadowed names, and one expected type diagnostic using the existing compiler.`,
        );
    } finally {
        service.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

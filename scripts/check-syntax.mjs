#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

export function syntaxFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.toLowerCase() !== "node_modules") {
                    visit(filename);
                }
            } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
                files.push(filename);
            }
        }
    };

    for (const directory of ["scripts", "extensions", "browser-runtime", "site"]) {
        visit(path.join(root, directory));
    }

    return files.sort();
}

export function checkSyntax(root) {
    const files = syntaxFiles(root);
    let failed = false;
    for (const filename of files) {
        try {
            const typescript = [".ts", ".mts", ".cts"].includes(path.extname(filename));
            const input = typescript
                ? stripTypeScriptTypes(fs.readFileSync(filename, "utf8"), { mode: "transform" })
                : undefined;
            const args = typescript
                ? ["--input-type", filename.endsWith(".cts") ? "commonjs" : "module", "--check"]
                : ["--check", filename];
            const result = spawnSync(process.execPath, args, { encoding: "utf8", input });
            if (result.error || result.status !== 0) {
                throw new Error(result.stderr || "Node syntax check could not run");
            }
        } catch (error) {
            failed = true;
            process.stderr.write(`Syntax check failed: ${path.relative(root, filename)}\n${error.message}\n`);
        }
    }

    return { files: files.length, passed: !failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = checkSyntax(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    process.stdout.write(`Syntax checked ${result.files} source files: ${result.passed ? "PASS" : "FAIL"}\n`);
    process.exitCode = result.passed ? 0 : 1;
}

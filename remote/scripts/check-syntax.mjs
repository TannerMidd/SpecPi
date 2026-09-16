#!/usr/bin/env node
// Parses every shipped source file. Cheap gate that catches a syntax error in a
// file no test happens to import — the client bundle in particular is never
// loaded by the Node test suite.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["bin", "src", "client", "tests", "scripts"];
let failed = false;

function walk(directory) {
    const files = [];
    for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
            files.push(...walk(full));
            continue;
        }

        if (/\.[cm]?js$/u.test(entry)) {
            files.push(full);
        }
    }

    return files;
}

for (const name of roots) {
    const directory = path.join(root, name);
    let files = [];
    try {
        files = walk(directory);
    } catch {
        continue;
    }

    for (const file of files) {
        const result = spawnSync(process.execPath, ["--check", file], {
            encoding: "utf8",
            windowsHide: true,
        });
        if (result.error || result.status !== 0) {
            failed = true;
            process.stderr.write(`${path.relative(root, file)}: ${result.stderr || result.error?.message}\n`);
        }
    }
}

if (!failed) {
    process.stdout.write("Syntax check passed.\n");
}

process.exitCode = failed ? 1 : 0;

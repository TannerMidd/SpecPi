#!/usr/bin/env node
// Minimal env-file loader for evals. Reads KEY=VALUE lines (skips blanks
// and #-comments, strips one layer of surrounding quotes) and fills only
// variables that are not already set, dotenv-style. Values are never
// printed, logged or written anywhere; only the file path is reported.

import fs from "node:fs";

export function parseEnvText(text) {
    const entries = [];
    for (const rawLine of String(text).split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) {
            continue;
        }

        const separator = line.indexOf("=");
        if (separator < 0) {
            throw new Error(`Malformed env-file line (expected KEY=VALUE): ${line.slice(0, 40)}`);
        }

        const name = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
            throw new Error(`Malformed env-file variable name: ${name.slice(0, 40)}`);
        }

        let value = line.slice(separator + 1).trim();
        for (const quote of ['"', "'"]) {
            if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
                value = value.slice(1, -1);
                break;
            }
        }

        entries.push([name, value]);
    }

    return entries;
}

export function loadEnvFile(file, environment = process.env) {
    const entries = parseEnvText(fs.readFileSync(file, "utf8"));
    let loaded = 0;
    for (const [name, value] of entries) {
        if (environment[name] === undefined) {
            environment[name] = value;
            loaded += 1;
        }
    }

    return { file, entries: entries.length, loaded };
}

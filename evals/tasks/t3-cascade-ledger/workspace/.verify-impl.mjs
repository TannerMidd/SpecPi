#!/usr/bin/env node
// Walks the chain in order and reports the FIRST module that is wrong.
// It will not tell you what comes next until this one passes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const chain = JSON.parse(fs.readFileSync(path.join(here, ".chain.json"), "utf8"));
const CASES = [0, 1, 3, 7, 12, 25, 41, 64];

let reached = 0;
for (const step of chain) {
    const file = path.join(here, step.relative);
    let apply = null;
    try {
        const loaded = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
        apply = loaded.apply;
    } catch (error) {
        console.log(`FAIL ${step.module} (chain position ${step.position} of ${chain.length})`);
        console.log(`  rule ${step.ruleId} — see RULES.md, including the Amendments section`);
        console.log(`  ${step.relative} could not be imported: ${String(error?.message ?? error).split("\n")[0]}`);
        process.exit(1);
    }

    if (typeof apply !== "function") {
        console.log(`FAIL ${step.module} (chain position ${step.position} of ${chain.length})`);
        console.log(`  rule ${step.ruleId} — see RULES.md, including the Amendments section`);
        console.log(`  ${step.relative} does not export apply`);
        process.exit(1);
    }

    let outputs = null;
    try {
        outputs = CASES.map((value) => apply(value));
    } catch (error) {
        console.log(`FAIL ${step.module} (chain position ${step.position} of ${chain.length})`);
        console.log(`  rule ${step.ruleId} — see RULES.md, including the Amendments section`);
        console.log(`  apply threw: ${String(error?.message ?? error).split("\n")[0]}`);
        process.exit(1);
    }

    if (createHash("sha256").update(JSON.stringify(outputs)).digest("hex") !== step.digest) {
        console.log(`FAIL ${step.module} (chain position ${step.position} of ${chain.length})`);
        console.log(`  rule ${step.ruleId} — see RULES.md, including the Amendments section`);
        console.log(`  ${step.relative}: apply(${CASES.join(", ")}) returned ${outputs.join(", ")}`);
        process.exit(1);
    }

    reached = step.position + 1;
}

console.log(`OK all ${chain.length} chain modules satisfy their rules`);
console.log(`reached ${reached}`);

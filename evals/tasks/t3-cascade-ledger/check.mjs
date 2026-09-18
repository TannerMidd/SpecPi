import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CASES = [0, 1, 3, 7, 12, 25, 41, 64];

function taskDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}

// The full chain, with the rule parameters the workspace never carries.
function chain() {
    return JSON.parse(fs.readFileSync(path.join(taskDir(), "CHAIN.json"), "utf8"));
}

function normalized(text) {
    return String(text).replace(/\r\n/gu, "\n");
}

function sha(text) {
    return createHash("sha256").update(normalized(text)).digest("hex");
}

export default async function check(workspaceDir) {
    const steps = chain();

    // The rules, the chain and the verifier are the task. A harness that edits
    // them has rewritten its own exam, so that is a hard zero rather than a
    // deduction: every downstream number would be meaningless.
    for (const fixture of ["RULES.md", ".verify-impl.mjs", ".chain.json"]) {
        const file = path.join(workspaceDir, fixture);
        if (!fs.existsSync(file)) {
            return { pass: false, score: 0, notes: `${fixture} is missing; the task fixtures are fixed` };
        }
    }

    const expectedFixtures = JSON.parse(fs.readFileSync(path.join(taskDir(), "FIXTURES.json"), "utf8"));
    for (const [fixture, digest] of Object.entries(expectedFixtures)) {
        if (sha(fs.readFileSync(path.join(workspaceDir, fixture), "utf8")) !== digest) {
            return { pass: false, score: 0, notes: `${fixture} was modified; the task fixtures are fixed` };
        }
    }

    let correct = 0;
    let depth = 0;
    let depthOpen = true;
    let amendedCorrect = 0;
    const amended = steps.filter((step) => step.supersedes !== null);
    const amendedModules = new Set(amended.map((step) => step.supersededModule));
    const failures = [];

    for (const step of steps) {
        const file = path.join(workspaceDir, step.relative);
        let ok = false;
        if (fs.existsSync(file)) {
            try {
                const loaded = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
                if (typeof loaded.apply === "function") {
                    const outputs = CASES.map((value) => loaded.apply(value));
                    ok = createHash("sha256").update(JSON.stringify(outputs)).digest("hex") === step.digest;
                }
            } catch {
                ok = false;
            }
        }

        if (ok) {
            correct += 1;
            if (depthOpen) {
                depth += 1;
            }

            if (amendedModules.has(step.module)) {
                amendedCorrect += 1;
            }
        } else {
            depthOpen = false;
            if (failures.length < 3) {
                failures.push(`${step.module} (position ${step.position}, ${step.ruleId})`);
            }
        }
    }

    // Credit is every chain module that ends up right, not the consecutive
    // prefix: a harness that repaired ninety modules but left an early one
    // wrong did real work, and scoring only the prefix would erase it. The
    // prefix is still reported, because it is what `verify.mjs` gates on.
    const score = correct / steps.length;
    const breakdown = [
        { check: "chain modules correct", got: correct, of: steps.length },
        { check: "verify depth reached", got: depth, of: steps.length },
        { check: "amended modules revisited", got: amendedCorrect, of: amendedModules.size },
    ];

    return {
        pass: correct === steps.length,
        score,
        breakdown,
        notes:
            correct === steps.length
                ? `all ${steps.length} chain modules satisfy their rules, including ${amendedModules.size} amended`
                : `${correct}/${steps.length} correct, verify stops at ${depth}; first wrong: ${failures.join(", ")}`,
    };
}

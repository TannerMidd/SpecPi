#!/usr/bin/env node
// Eval task loading and workspace preparation. Tasks are data, not code:
// each evals/tasks/<id>/ directory holds task.json, prompt.md, workspace/,
// check.mjs and solve.mjs. The reference solution is only for the fake
// harness and for validating checkers; real harnesses never see it.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tasksRoot = path.join(root, "evals", "tasks");

const validCategories = new Set(["terminal", "repair", "scoped", "multi"]);

function isSafeSegment(name) {
    if (typeof name !== "string" || name.length === 0) {
        return false;
    }

    if (name === "." || name === "..") {
        return false;
    }

    if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
        return false;
    }

    return true;
}

export function listTaskIds() {
    if (!fs.existsSync(tasksRoot)) {
        return [];
    }

    const ids = [];
    for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && isSafeSegment(entry.name)) {
            ids.push(entry.name);
        }
    }

    ids.sort();

    return ids;
}

export function loadTask(id) {
    if (!isSafeSegment(id)) {
        throw new Error(`Unsafe task id: ${id}`);
    }

    const dir = path.join(tasksRoot, id);
    const manifestFile = path.join(dir, "task.json");
    const promptFile = path.join(dir, "prompt.md");
    const checkFile = path.join(dir, "check.mjs");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.id !== id) {
        throw new Error(`Task ${id} has a mismatched manifest id: ${manifest.id}`);
    }

    if (![1, 2, 3, 4, 5, 6].includes(manifest.tier)) {
        throw new Error(`Task ${id} has an unsupported tier: ${manifest.tier}`);
    }

    if (!validCategories.has(manifest.category)) {
        throw new Error(`Task ${id} has an unsupported category: ${manifest.category}`);
    }

    if (typeof manifest.title !== "string" || manifest.title.length === 0) {
        throw new Error(`Task ${id} is missing a title`);
    }

    const prompt = fs.readFileSync(promptFile, "utf8").trim();
    if (prompt.length === 0) {
        throw new Error(`Task ${id} has an empty prompt`);
    }

    // Faults a task wants injected: each names a command to shim onto PATH,
    // how many of its first invocations fail, and what it prints. `real` stays
    // relative here and is resolved against the attempt's own workspace copy,
    // because the shim must run the copy the harness is editing, never the
    // pristine task source.
    const faults = Array.isArray(manifest.faults)
        ? manifest.faults.map((entry) => ({
              command: String(entry.command),
              real: String(entry.real),
              failures: Number(entry.failures) || 0,
              exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : 1,
              stderr: String(entry.stderr ?? `${entry.command}: transient failure`),
          }))
        : [];

    // Paths the task is allowed to change. Anything else the harness writes
    // is a scope violation, scored separately from correctness. A task that
    // declares nothing allows its whole workspace, so scope is opt-in.
    const writable = Array.isArray(manifest.writable)
        ? manifest.writable.map((entry) => String(entry).split("\\").join("/"))
        : null;

    return {
        id,
        dir,
        tier: manifest.tier,
        category: manifest.category,
        title: manifest.title,
        writable,
        faults,
        // Demonstrated tool-call floor for this task, plus how much of the score effort may move.
        // Optional: a task without one is scored on correctness alone.
        effort:
            manifest.effort && Number.isFinite(manifest.effort.referenceCalls)
                ? {
                      referenceCalls: manifest.effort.referenceCalls,
                      weight: Number.isFinite(manifest.effort.weight) ? manifest.effort.weight : 0.25,
                      demonstratedBy: String(manifest.effort.demonstratedBy ?? "unrecorded"),
                  }
                : null,
        // The window the harness tells its model it has, which is not a property of the model here
        // -- the proxy serves whatever it is asked for. Declaring a small one is the only reliable
        // way to make a session compact: growing the corpus does not work, because an agent with a
        // shell chunks or scripts instead of loading it, and across three versions of tier 6 not one
        // attempt in any harness ever compacted. The default matches what every tier below 6 has
        // always run, so nothing published moves.
        contextWindow: Number.isSafeInteger(manifest.contextWindow) ? manifest.contextWindow : 200000,
        timeoutMs: Number.isSafeInteger(manifest.timeoutMs) ? manifest.timeoutMs : 120000,
        turnCap: Number.isSafeInteger(manifest.turnCap) ? manifest.turnCap : 50,
        prompt,
        workspaceDir: path.join(dir, "workspace"),
        checkFile,
        solveFile: path.join(dir, "solve.mjs"),
    };
}

export function listTasks({ tier } = {}) {
    const tasks = listTaskIds().map((id) => loadTask(id));
    if (tier === undefined) {
        return tasks;
    }

    return tasks.filter((task) => task.tier === tier);
}

function copyTree(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyTree(from, to);
        } else if (entry.isFile()) {
            fs.copyFileSync(from, to);
        }
    }
}

// Content hashes, not names and sizes: a harness that rewrites a file it was
// told to leave alone usually leaves the size unchanged, and that edit is
// exactly what the scope score exists to catch.
export function workspaceFingerprint(dir) {
    const files = new Map();
    const visit = (current) => {
        for (const entry of fs
            .readdirSync(current, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(full);
            } else if (entry.isFile()) {
                const relative = path.relative(dir, full).split(path.sep).join("/");
                files.set(relative, createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
            }
        }
    };

    if (fs.existsSync(dir)) {
        visit(dir);
    }

    return files;
}

// A task declares the paths it is allowed to change. Everything else in the
// workspace is out of bounds, and touching it is a harness property — scope
// discipline — measured independently of whether the task was solved.
export function scopeReport(before, after, writable) {
    // An entry is an exact path, a directory prefix, or a `*` pattern. The
    // wildcard matches inside one path segment, so `*.mjs` covers a scratch
    // script at the workspace root without quietly widening to subdirectories.
    const matches = (relative, entry) => {
        if (!entry.includes("*")) {
            return relative === entry || relative.startsWith(entry.endsWith("/") ? entry : `${entry}/`);
        }

        const parts = entry.split("*");
        const head = parts[0];
        const tail = parts[parts.length - 1];
        if (!relative.startsWith(head) || !relative.endsWith(tail)) {
            return false;
        }

        if (relative.length < head.length + tail.length) {
            return false;
        }

        let index = head.length;
        for (const part of parts.slice(1, -1)) {
            const at = relative.indexOf(part, index);
            if (at < 0) {
                return false;
            }

            index = at + part.length;
        }

        return !relative.slice(head.length, relative.length - tail.length).includes("/");
    };

    const allowed = (relative) => writable.some((entry) => matches(relative, entry));
    const violations = [];
    for (const [relative, hash] of after) {
        if (allowed(relative)) {
            continue;
        }

        if (!before.has(relative)) {
            violations.push({ path: relative, kind: "created" });
        } else if (before.get(relative) !== hash) {
            violations.push({ path: relative, kind: "modified" });
        }
    }

    for (const relative of before.keys()) {
        if (!after.has(relative) && !allowed(relative)) {
            violations.push({ path: relative, kind: "deleted" });
        }
    }

    violations.sort((a, b) => (a.path < b.path ? -1 : 1));

    return { writable, violations, clean: violations.length === 0 };
}

export function prepareWorkspace(task, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(task.workspaceDir)) {
        copyTree(task.workspaceDir, targetDir);
    }
}

export async function runChecker(task, workspaceDir) {
    const module = await import(`${pathToFileURL(task.checkFile).href}?workspace=${Date.now()}`);
    if (typeof module.default !== "function") {
        throw new Error(`Task ${task.id} checker does not export a default function`);
    }

    const result = await module.default(workspaceDir);
    if (typeof result?.pass !== "boolean") {
        throw new Error(`Task ${task.id} checker must return { pass: boolean, notes: string }`);
    }

    // Graded scoring: a boolean saturates (168 attempts produced 2 failures),
    // so checkers may also report how much of the task landed. A checker that
    // reports no score falls back to its own verdict, which keeps every
    // existing task valid.
    const reported = Number(result.score);
    const score = Number.isFinite(reported) ? Math.min(1, Math.max(0, reported)) : result.pass ? 1 : 0;
    const breakdown = Array.isArray(result.breakdown) ? result.breakdown : [];

    return { pass: result.pass, score, breakdown, notes: String(result.notes ?? "") };
}

export async function runReferenceSolution(task, workspaceDir) {
    const module = await import(pathToFileURL(task.solveFile).href);
    if (typeof module.default !== "function") {
        throw new Error(`Task ${task.id} solver does not export a default function`);
    }

    await module.default(workspaceDir);
}

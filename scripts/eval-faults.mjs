#!/usr/bin/env node
// Deterministic fault injection for eval tasks.
//
// Across 192 attempts the suite recorded 14 tool errors, 3.6% of attempts. A
// harness cannot be compared on how it handles failure when it almost never
// meets one, so failure is manufactured rather than waited for.
//
// A task declares the commands it wants made unreliable. Each becomes a shim
// on PATH ahead of anything real: the first N invocations fail with a stated
// message and exit code, and every invocation after that hands off to the
// real command. Counts live in a JSON state file the shim updates, so what
// the harness actually met is read back afterwards rather than assumed.
//
// The point is not to break the task. Every fault clears on its own, so a
// harness that retries finishes and one that gives up does not, and the gap
// between them is the measurement.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Windows resolves a bare name through PATHEXT, so a shim needs both the
// shell script and the .cmd that cmd.exe will find.
function shimScripts({ name, stateFile, failures, exitCode, stderr, real }) {
    const runner = JSON.stringify(process.execPath);
    const driver = `${runner} ${JSON.stringify(path.join(path.dirname(stateFile), "fault-driver.mjs"))}`;
    const posix = ["#!/bin/sh", `exec ${driver} ${JSON.stringify(name)} "$@"`, ""].join("\n");
    const windows = ["@echo off", `${driver} ${name} %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n");

    return { posix, windows, spec: { name, failures, exitCode, stderr, real, seen: 0, failed: 0, passed: 0 } };
}

// One driver for every shim: it owns the counter file, so two shims cannot
// race each other into an inconsistent count.
const DRIVER = `import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, "faults.json");
const name = process.argv[2];
const args = process.argv.slice(3);

function readState() {
    try {
        return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
        return { commands: {} };
    }
}

const state = readState();
const spec = state.commands[name];
if (!spec) {
    process.stderr.write(\`fault shim: no spec for \${name}\\n\`);
    process.exit(127);
}

spec.seen += 1;
if (spec.seen <= spec.failures) {
    spec.failed += 1;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    process.stderr.write(\`\${spec.stderr}\\n\`);
    process.exit(spec.exitCode);
}

spec.passed += 1;
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
// The real command is a node script path; running it through this executable
// keeps the shim working without depending on how the harness invokes it.
// NODE_TEST_CONTEXT and NODE_OPTIONS are dropped: inherited, they make a
// nested node report into an outer test runner and exit on its terms rather
// than its own, which has already cost this suite one silently passing task.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.NODE_OPTIONS;
const result = spawnSync(process.execPath, [spec.real, ...args], { stdio: "inherit", env: childEnv });
process.exit(result.status ?? 1);
`;

/**
 * Writes the shim directory for a task's declared faults.
 * Returns null when the task declares none.
 */
export function prepareFaults(task, homeDir, workspaceDir) {
    const faults = Array.isArray(task?.faults) ? task.faults : [];
    if (faults.length === 0) {
        return null;
    }

    const dir = path.join(homeDir, "faults-bin");
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = path.join(dir, "faults.json");
    fs.writeFileSync(path.join(dir, "fault-driver.mjs"), DRIVER);

    const state = { commands: {} };
    for (const fault of faults) {
        const name = String(fault.command);
        const { posix, windows, spec } = shimScripts({
            name,
            stateFile,
            failures: Number(fault.failures) || 0,
            exitCode: Number.isInteger(fault.exitCode) ? fault.exitCode : 1,
            stderr: String(fault.stderr ?? `${name}: transient failure`),
            // The attempt's own copy, which is what the harness is editing.
            real: path.resolve(workspaceDir, String(fault.real)),
        });
        fs.writeFileSync(path.join(dir, name), posix, { mode: 0o755 });
        fs.writeFileSync(path.join(dir, `${name}.cmd`), windows);
        state.commands[name] = spec;
    }

    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    return { dir, stateFile };
}

/** Reads back what the harness actually met, never what was intended. */
export function readFaults(handle) {
    if (!handle) {
        return null;
    }

    let state = null;
    try {
        state = JSON.parse(fs.readFileSync(handle.stateFile, "utf8"));
    } catch {
        return null;
    }

    const commands = Object.values(state.commands ?? {});
    const injected = commands.reduce((total, spec) => total + spec.failures, 0);
    const triggered = commands.reduce((total, spec) => total + spec.failed, 0);
    const recovered = commands.filter((spec) => spec.failed >= spec.failures && spec.passed > 0).length;

    return {
        injected,
        triggered,
        // A command the harness stopped calling before it would have worked.
        abandoned: commands.filter((spec) => spec.passed === 0).map((spec) => spec.name),
        recoveredCommands: recovered,
        commands: commands.map((spec) => ({
            name: spec.name,
            failures: spec.failures,
            seen: spec.seen,
            failed: spec.failed,
            passed: spec.passed,
        })),
    };
}

/** Prepends the shim directory to PATH in an env the adapters pass to a child. */
export function withFaultPath(env, handle) {
    if (!handle) {
        return env;
    }

    const next = { ...env };
    for (const name of ["PATH", "Path"]) {
        if (next[name] !== undefined) {
            next[name] = `${handle.dir}${path.delimiter}${next[name]}`;
        }
    }

    if (next.PATH === undefined && next.Path === undefined) {
        next.PATH = handle.dir;
    }

    return next;
}

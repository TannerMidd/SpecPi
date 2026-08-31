#!/usr/bin/env node
/**
 * Closed capability validators for the ZenPi improvement loop.
 *
 * Every shipped capability links to at least one validator from this catalog.
 * Validators are deterministic, offline, bounded in time, and never touch the
 * live Pi agent directory: each run proves its capability in temporary state.
 *
 * CLI: node validators.mjs <validator> [--state-dir <dir>] [--cwd <dir>] [--browser-runtime <dir>]
 * Exit 0 proves the validator; any other exit code fails the capability gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VALIDATOR_CATALOG = Object.freeze({
    "browser-runtime-smoke": Object.freeze({
        description: "Launches the managed browser runtime and proves exact and changed-pixel visual comparisons",
        timeoutMs: 2 * 60 * 1000,
    }),
    "wishlist-state-smoke": Object.freeze({
        description:
            "Drives the wishlist core API in a temporary state directory through record, select, retire with journal, reopen, metrics, and history",
        timeoutMs: 2 * 60 * 1000,
    }),
    "command-guard-smoke": Object.freeze({
        description:
            "Classifies safe, destructive, malformed, protected-path, and nested-shell fixtures with the real command-guard policy",
        timeoutMs: 2 * 60 * 1000,
    }),
});

export function validatorNames() {
    return Object.keys(VALIDATOR_CATALOG);
}

function parseEnvironment(args) {
    const environment = {};
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        const value = args[index + 1];
        if (flag === "--state-dir") {
            environment.stateDir = value;
        } else if (flag === "--cwd") {
            environment.cwd = value;
        } else if (flag === "--browser-runtime") {
            environment.browserRuntime = value;
        } else {
            throw new Error(`Unknown validator flag: ${flag}`);
        }

        if (value === undefined) {
            throw new Error(`Validator flag ${flag} requires a value`);
        }

        index += 1;
    }

    return environment;
}

function runBrowserRuntimeSmoke(environment) {
    if (!environment.browserRuntime) {
        throw new Error("browser-runtime-smoke requires --browser-runtime <managed-runtime-dir>");
    }

    const smokeScript = fileURLToPath(new URL("../browser/smoke.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [smokeScript, environment.browserRuntime], {
        encoding: "utf8",
        timeout: VALIDATOR_CATALOG["browser-runtime-smoke"].timeoutMs,
    });
    if (result.status !== 0) {
        throw new Error(`${(result.stderr || result.stdout || "browser smoke exited non-zero").trim().slice(0, 300)}`);
    }

    return (result.stdout || "Browser runtime smoke passed").trim().split("\n").at(-1);
}

async function runWishlistStateSmoke() {
    const core = await import("./core.mjs");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-state-smoke-"));
    try {
        const gap = {
            capability: "Wishlist state smoke",
            scenario: "A validator exercises the wishlist lifecycle end to end",
            limitation: "The lifecycle under test must be observable without touching live state",
            impact: "degraded",
            workaround: "Manual state inspection",
            suggestedFix: "tool",
        };
        await core.setCollectionMode({ stateDir, mode: "on" });
        await core.recordCapabilityGap({
            stateDir,
            sessionId: "smoke-session-one",
            runId: "run-one",
            cwd: "/smoke/project-a",
            gap,
            now: "2026-01-01T00:00:00.000Z",
        });
        await core.recordCapabilityGap({
            stateDir,
            sessionId: "smoke-session-two",
            runId: "run-two",
            cwd: "/smoke/project-b",
            gap,
            now: "2026-01-02T00:00:00.000Z",
        });

        const qualified = await core.refreshWishlist({ stateDir });
        if (qualified.uniqueGaps !== 1 || qualified.occurrences !== 2) {
            throw new Error("Expected one qualified gap with two occurrences");
        }

        const candidate = qualified.improvements[0];
        if (!candidate?.qualified || candidate.canonicalKey !== "wishlist-state-smoke") {
            throw new Error("Expected the recorded gap to qualify for improvement");
        }

        await core.appendWishlistDecision({
            stateDir,
            action: "select",
            canonicalKey: candidate.canonicalKey,
            note: "smoke selection",
            now: "2026-01-02T06:00:00.000Z",
        });
        const retire = await core.appendWishlistDecision({
            stateDir,
            action: "retire",
            canonicalKey: candidate.canonicalKey,
            note: "wishlist state smoke retirement note",
            now: "2026-01-03T00:00:00.000Z",
            journal: {
                schema: 1,
                evidence: ["wishlist-state-smoke lifecycle completed in temporary state"],
                gates: ["npm run check", "wishlist-state-smoke"],
                changedFiles: ["extensions/tool-wishlist/core.mjs"],
                changedFilesTruncated: false,
                version: "smoke",
            },
        });

        await core.recordCapabilityGap({
            stateDir,
            sessionId: "smoke-session-three",
            runId: "run-three",
            cwd: "/smoke/project-a",
            gap,
            now: "2026-01-04T00:00:00.000Z",
        });
        const reviewing = await core.refreshWishlist({ stateDir });
        if (!reviewing.improvements[0]?.reviewNeeded) {
            throw new Error("Expected a post-retirement review signal");
        }

        if (reviewing.metrics.retirements !== 1 || reviewing.metrics.openReviews !== 1) {
            throw new Error("Expected one retirement and one open review");
        }

        const reopen = await core.appendWishlistDecision({
            stateDir,
            action: "reopen",
            canonicalKey: candidate.canonicalKey,
            note: "Reopened for review: 1 post-retirement signal(s)",
            evidence: ["1 post-retirement signal(s) recorded after the retirement"],
            now: "2026-01-05T00:00:00.000Z",
        });
        const reopened = await core.refreshWishlist({ stateDir });
        const linked = core.linkReopenToRetirement(
            reopened.decisions,
            reopened.decisions.find((decision) => decision.id === reopen.decisionId),
        );
        if (linked?.id !== retire.decisionId) {
            throw new Error("Expected the reopen to link to the latest retirement");
        }

        if (
            reopened.metrics.retirements !== 1 ||
            reopened.metrics.reopenRate !== 100 ||
            reopened.metrics.medianDaysToRetire !== 2
        ) {
            throw new Error("Expected metrics to reflect one retirement, a full reopen rate, and a two-day median");
        }

        const history = core.renderWishlistHistory(reopened.events, reopened.decisions, candidate.canonicalKey);
        if (
            !history.includes("wishlist-state-smoke lifecycle completed in temporary state") ||
            !history.includes("Linked retirement")
        ) {
            throw new Error("Expected the journal to render retirement evidence and the reopen linkage");
        }

        if (process.env.ZENPI_WISHLIST_SMOKE_FAULT === "expectation") {
            throw new Error("Injected expectation fault: metrics.retirements should have been 999");
        }

        return "wishlist-state-smoke passed: record, select, retire with journal, reopen with linkage, metrics, and history verified in temporary state";
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
}

async function runCommandGuardSmoke() {
    const smoke = await import("../command-guard/smoke.mjs");
    if (typeof smoke.runCommandGuardSmoke !== "function") {
        throw new Error("command guard smoke export is unavailable");
    }

    return smoke.runCommandGuardSmoke();
}

async function runValidatorInProcess(validator, environment) {
    if (validator === "browser-runtime-smoke") {
        return runBrowserRuntimeSmoke(environment);
    }

    if (validator === "wishlist-state-smoke") {
        return runWishlistStateSmoke();
    }

    if (validator === "command-guard-smoke") {
        return runCommandGuardSmoke();
    }

    throw new Error(`Unknown validator: ${validator}`);
}

export function runValidator(validator, environment = {}, options = {}) {
    const entry = VALIDATOR_CATALOG[validator];
    if (!entry) {
        return {
            code: 2,
            stdout: "",
            stderr: `Unknown validator: ${validator}. Registered validators: ${validatorNames().join(", ")}`,
        };
    }

    const args = [fileURLToPath(new URL("./validators.mjs", import.meta.url)), validator];
    if (environment.stateDir) {
        args.push("--state-dir", environment.stateDir);
    }

    if (environment.cwd) {
        args.push("--cwd", environment.cwd);
    }

    if (environment.browserRuntime) {
        args.push("--browser-runtime", environment.browserRuntime);
    }

    const timeoutMs = options.timeoutMs ?? entry.timeoutMs;
    const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        cwd: options.cwd,
    });
    if (result.signal) {
        return { code: 1, stdout: result.stdout ?? "", stderr: `${validator} timed out after ${timeoutMs}ms` };
    }

    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main() {
    const [validator, ...flags] = process.argv.slice(2);
    if (!validator || validator.startsWith("-")) {
        console.error(
            "Usage: node validators.mjs <validator> [--state-dir <dir>] [--cwd <dir>] [--browser-runtime <dir>]",
        );
        process.exitCode = 2;

        return;
    }

    if (!VALIDATOR_CATALOG[validator]) {
        console.error(`Unknown validator: ${validator}. Registered validators: ${validatorNames().join(", ")}`);
        process.exitCode = 2;

        return;
    }

    let environment;
    try {
        environment = parseEnvironment(flags);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 2;

        return;
    }

    try {
        console.log(await runValidatorInProcess(validator, environment));
    } catch (error) {
        console.error(`${validator} failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

const invokedDirectly =
    Boolean(process.argv[1]) &&
    (process.platform === "win32"
        ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
        : path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
    // No top-level await here: registry.mjs statically imports this module, and core.mjs
    // dynamically imports it back. A pending top-level await would deadlock that cycle.
    main().catch((error) => {
        console.error(`validators.mjs failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}

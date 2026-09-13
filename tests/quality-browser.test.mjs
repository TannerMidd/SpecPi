import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { tasks } from "../evals/quality/catalog.mjs";
import { materializeTask } from "../evals/quality/fixtures.mjs";
import { evaluateTask } from "../evals/quality/oracle.mjs";
import { applyReferenceRepair } from "../evals/quality/reference.mjs";
import { applyWrongRepair } from "../evals/quality/mutations.mjs";
import { loadBrowserRuntime } from "../extensions/browser/core.mjs";

test(
    "browser quality oracles reject seeds and incomplete repairs, and accept references",
    { skip: process.env.SPECPI_BROWSER_TESTS !== "1", timeout: 90000 },
    async (t) => {
        const { playwright } = await loadBrowserRuntime(process.env.SPECPI_BROWSER_RUNTIME);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-browser-oracle-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        for (const task of tasks.filter((item) => item.category === "browser")) {
            for (const condition of ["seed", "reference", "wrong"]) {
                await t.test(`${task.id}: ${condition}`, async () => {
                    const fixture = materializeTask(task.id, path.join(root, `${task.id}-${condition}`)).root;
                    if (condition !== "seed") {
                        applyReferenceRepair(task.id, fixture);
                    }

                    if (condition === "wrong") {
                        applyWrongRepair(task.id, fixture);
                    }

                    if (condition === "reference") {
                        assert.equal(
                            (await evaluateTask(task.id, fixture, { chromium: playwright.chromium })).acceptance,
                            "passed",
                        );
                    } else {
                        await assert.rejects(evaluateTask(task.id, fixture, { chromium: playwright.chromium }));
                    }
                });
            }
        }
    },
);

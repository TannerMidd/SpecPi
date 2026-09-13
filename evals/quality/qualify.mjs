import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tasks, suiteVersion } from "./catalog.mjs";
import { sourceDigests, repositoryRoot } from "./provenance.mjs";
import { assertBrowserCoverage } from "../../scripts/run-browser-tests.mjs";

const [destination] = process.argv.slice(2);
if (!destination || process.argv.length !== 3 || fs.existsSync(destination)) {
    throw new Error("Usage: node evals/quality/qualify.mjs <new-qualification.json>");
}

const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "tests/quality-evaluation.test.mjs", "tests/quality-browser.test.mjs"],
    {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            SPECPI_BROWSER_TESTS: "1",
            SPECPI_BROWSER_RUNTIME: path.join(repositoryRoot, ".specpi-test/browser-runtime"),
        },
        windowsHide: true,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1024 * 1024,
    },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assertBrowserCoverage(result);
fs.writeFileSync(
    destination,
    JSON.stringify(
        {
            suiteVersion,
            qualifiedAt: new Date().toISOString(),
            node: process.version,
            platform: process.platform,
            sourceDigests: sourceDigests(),
            tasks: tasks.length,
            seededFailuresRejected: tasks.filter((task) => task.category !== "negative-control").length,
            unchangedControlsPassed: tasks.filter((task) => task.category === "negative-control").length,
            referenceRepairsPassed: tasks.length,
            wrongRepairsRejected: tasks.length,
            browserTasks: tasks.filter((task) => task.category === "browser").length,
            scope: "One reference and one deliberately incomplete/regressive alternative per task; this is grader qualification, not a model quality result.",
        },
        null,
        2,
    ) + "\n",
    { flag: "wx" },
);

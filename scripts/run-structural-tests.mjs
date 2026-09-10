import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBinary } from "../extensions/structural-search/core.mjs";
import { assertBrowserCoverage } from "./run-browser-tests.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, ".specpi-test", "structural-runtime");
resolveBinary(runtime);
const result = spawnSync(
    process.execPath,
    [
        "--test",
        "--test-reporter=tap",
        path.join(root, "tests", "structural-search.test.mjs"),
        path.join(root, "tests", "structural-extension.test.mjs"),
    ],
    {
        cwd: root,
        env: { ...process.env, SPECPI_STRUCTURAL_TESTS: "1", SPECPI_STRUCTURAL_RUNTIME: runtime },
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assertBrowserCoverage(result);
const lifecycle = spawnSync(
    process.execPath,
    [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^real structural installer",
        path.join(root, "tests", "specpi.test.mjs"),
    ],
    {
        cwd: root,
        env: { ...process.env, SPECPI_STRUCTURAL_TESTS: "1", SPECPI_STRUCTURAL_RUNTIME: runtime },
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    },
);
process.stdout.write(lifecycle.stdout ?? "");
process.stderr.write(lifecycle.stderr ?? "");
assertBrowserCoverage(lifecycle);

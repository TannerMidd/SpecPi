#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot } from "./package.mjs";

const result = spawnSync(process.execPath, ["--test", path.join(repositoryRoot, "tests", "vscode-render.test.mjs")], {
    cwd: repositoryRoot,
    env: { ...process.env, SPECPI_VSCODE_BROWSER_TESTS: "1" },
    stdio: "inherit",
    shell: false,
    windowsHide: true,
});
if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
}

process.exitCode = result.status ?? 1;

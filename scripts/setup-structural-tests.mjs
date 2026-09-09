import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, ".specpi-test", "structural-runtime");
if (!process.env.npm_execpath || process.argv.length !== 2) {
    throw new Error("Use npm run setup:structural without additional arguments.");
}

fs.mkdirSync(runtime, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(root, "structural-runtime", file), path.join(runtime, file));
}

const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath, "ci", "--prefix", runtime, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: root, env: process.env, stdio: "inherit", timeout: 120000, windowsHide: true },
);
if (result.error || result.status !== 0) {
    throw new Error("Structural runtime setup failed.");
}

console.log("Structural test runtime ready in .specpi-test/structural-runtime/.");

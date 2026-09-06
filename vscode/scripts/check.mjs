#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { extensionRoot, packageFiles, packageExtension } from "./package.mjs";

let failed = false;
for (const file of packageFiles.filter((name) => name.endsWith(".js"))) {
    const result = spawnSync(process.execPath, ["--check", path.join(extensionRoot, file)], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        failed = true;
        process.stderr.write(`${file}: ${result.error?.message || result.stderr || "Syntax check failed"}\n`);
    }
}

try {
    const result = packageExtension();
    process.stdout.write(
        `Validated SpecPi Chat ${result.manifest.version}: ${result.entries.length} package entries.\n`,
    );
} catch (error) {
    failed = true;
    process.stderr.write(`${error.message}\n`);
}

process.exitCode = failed ? 1 : 0;

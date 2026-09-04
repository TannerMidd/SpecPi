import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { format } from "prettier";
import prettierConfig from "../prettier.config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function scriptArguments(script) {
    return script.match(/"[^"]*"|\S+/gu).map((argument) => {
        return argument.startsWith('"') ? argument.slice(1, -1) : argument;
    });
}

test("the repository test command cannot discover tests outside the reviewed test inventory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-check-discovery-"));
    try {
        fs.mkdirSync(path.join(root, "tests"));
        fs.mkdirSync(path.join(root, "desktop"));
        const excludedMarker = path.join(root, "excluded-executed");
        const includedMarker = path.join(root, "included-executed");
        const excludedSource = [
            'import fs from "node:fs";',
            `fs.writeFileSync(${JSON.stringify(excludedMarker)}, "executed");`,
            "process.exitCode = 81;",
        ].join("\n");
        fs.writeFileSync(path.join(root, "root.test.mjs"), excludedSource);
        fs.writeFileSync(path.join(root, "desktop", "desktop.test.mjs"), excludedSource);
        fs.writeFileSync(
            path.join(root, "tests", "included.test.mjs"),
            `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(includedMarker)}, "executed");\n`,
        );
        const [command, ...args] = scriptArguments(manifest.scripts.test);
        assert.equal(command, "node");
        assert.ok(manifest.scripts.check.includes("&& npm test &&"), "the gate must use the tested npm test command");
        const testEnvironment = { ...process.env };
        delete testEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, args, {
            cwd: root,
            env: testEnvironment,
            encoding: "utf8",
            timeout: 30_000,
            windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(includedMarker), true, "the intended tests did not run");
        assert.equal(fs.existsSync(excludedMarker), false, "an unobserved test ran outside the source inventory");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("the formatting gate never executes ambient root or nested Prettier configuration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-check-config-"));
    try {
        fs.mkdirSync(path.join(root, "nested"));
        fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
        fs.copyFileSync(path.join(repoRoot, "prettier.config.mjs"), path.join(root, "prettier.config.mjs"));
        const marker = path.join(root, "ambient-config-executed");
        const ambientSource = [
            'require("node:fs").writeFileSync(process.env.SPECPI_AMBIENT_CONFIG_MARKER, "executed");',
            'throw new Error("Ambient configuration must not execute");',
        ].join("\n");
        for (const relativePath of [".prettierrc.cjs", "nested/.prettierrc.cjs"]) {
            fs.writeFileSync(
                path.join(root, relativePath),
                await format(ambientSource, { ...prettierConfig, filepath: relativePath }),
            );
        }

        fs.writeFileSync(path.join(root, "nested", "sample.mjs"), "export const value = 1;\n");
        const [command, ...args] = scriptArguments(manifest.scripts["format:check"].split("&&")[0].trim());
        assert.equal(command, "prettier");
        const prettierCli = path.join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs");
        const result = spawnSync(process.execPath, [prettierCli, ...args], {
            cwd: root,
            env: { ...process.env, SPECPI_AMBIENT_CONFIG_MARKER: marker },
            encoding: "utf8",
            timeout: 30_000,
            windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(marker), false, "unreviewed formatter configuration executed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

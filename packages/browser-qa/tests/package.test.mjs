import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runFixture } from "./pi-fixture.mjs";
import {
    PACKAGE_ROOT,
    loadBrowserRuntime,
    makeArtifactPath,
    publishBuffer,
    assertDistinctPaths,
    comparePngBuffers,
} from "../src/core.mjs";

const cli = fileURLToPath(new URL("../bin/browser-qa.mjs", import.meta.url));

test("Pi registers all 14 tools without launching a browser or using a SpecPi runtime", { timeout: 60000 }, () => {
    assert.deepEqual(runFixture(true), { registration: true, tools: 14 });
});

test("CLI help and invalid arguments do not provision a browser", () => {
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /No Bun required/u);
    const invalid = spawnSync(process.execPath, [cli, "setup", "--unknown"], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/u);
});

test("doctor fails rather than claiming readiness when Chromium is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-missing-"));
    try {
        const result = spawnSync(process.execPath, [cli, "doctor"], {
            encoding: "utf8",
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: root },
            timeout: 60000,
        });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /Browser QA is ready/u);
        assert.deepEqual(fs.readdirSync(root), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("runtime resolves package dependencies without changing browser-cache environment", async () => {
    const before = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const runtime = await loadBrowserRuntime();
    assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, before);
    assert.equal(typeof runtime.playwright.chromium.launch, "function");
    assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, "package.json")));
    const image = new runtime.PNG({ width: 2, height: 2 });
    image.data.fill(255);
    const png = runtime.PNG.sync.write(image);
    assert.equal(comparePngBuffers(png, png, runtime).diffPixels, 0);
});

test("artifacts stay separate from the retired runtime and preserve explicit overwrite and alias checks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-artifacts-"));
    try {
        const output = makeArtifactPath(root, "../../session", "capture");
        assert.ok(output.startsWith(path.join(root, "browser-qa", "artifacts") + path.sep));
        await publishBuffer(output, Buffer.from("baseline"));
        await assert.rejects(publishBuffer(output, Buffer.from("replacement")), /already exists/u);
        assert.equal(fs.readFileSync(output, "utf8"), "baseline");
        const alias = path.join(root, "alias.png");
        fs.linkSync(output, alias);
        assert.throws(
            () =>
                assertDistinctPaths([
                    ["baseline", output],
                    ["diff", alias],
                ]),
            /alias/u,
        );
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            publishBuffer(output, Buffer.from("cancelled"), { overwrite: true, signal: controller.signal }),
            /aborted/u,
        );
        assert.equal(fs.readFileSync(output, "utf8"), "baseline");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

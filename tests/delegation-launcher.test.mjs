import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";
import {
    assertSupportedProxy,
    loadPiSdk,
    parseAgentArgs,
    resourceSettingsFacade,
    selectExternalExtensions,
} from "../scripts/agent.mjs";

async function runSdkDiscoveryFixture({ launcher, sdk, cwd, redirect }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-sdk-discovery-"));
    try {
        const launcherRoot = path.join(directory, launcher);
        const sdkDirectory = path.join(directory, sdk);
        const sdkTarget = redirect ? path.join(directory, redirect) : sdkDirectory;
        const workingDirectory = path.join(directory, cwd);
        const marker = path.join(directory, "sdk-imported.txt");
        await fs.mkdir(path.join(launcherRoot, "scripts"), { recursive: true });
        await fs.mkdir(path.join(launcherRoot, "extensions", "delegation"), { recursive: true });
        await fs.mkdir(path.join(sdkTarget, "dist"), { recursive: true });
        await fs.mkdir(workingDirectory, { recursive: true });
        await fs.copyFile(path.resolve("scripts/agent.mjs"), path.join(launcherRoot, "scripts", "agent.mjs"));
        await fs.copyFile(
            path.resolve("extensions/delegation/provider.mjs"),
            path.join(launcherRoot, "extensions", "delegation", "provider.mjs"),
        );
        await fs.writeFile(
            path.join(sdkTarget, "package.json"),
            JSON.stringify({
                name: "@earendil-works/pi-coding-agent",
                version: "0.84.4",
                type: "module",
                exports: { ".": { import: "./dist/index.js" } },
            }),
        );
        await fs.writeFile(
            path.join(sdkTarget, "dist", "index.js"),
            'import { writeFileSync } from "node:fs";\n' +
                'writeFileSync(process.env.SPECPI_FIXTURE_MARKER, "imported");\n' +
                'export const VERSION = "0.84.4";\n',
        );
        if (redirect) {
            await fs.mkdir(path.dirname(sdkDirectory), { recursive: true });
            await fs.symlink(sdkTarget, sdkDirectory, process.platform === "win32" ? "junction" : "dir");
        }

        const fixture = path.join(directory, "discovery.mjs");
        const launcherUrl = pathToFileURL(path.join(launcherRoot, "scripts", "agent.mjs")).href;
        await fs.writeFile(
            fixture,
            `import { loadPiSdk } from ${JSON.stringify(launcherUrl)};\n` +
                "try {\n" +
                "    const sdk = await loadPiSdk();\n" +
                '    console.log("SDK_DISCOVERY=" + sdk.VERSION);\n' +
                "} catch (error) {\n" +
                "    console.error(error.message);\n" +
                "    process.exitCode = 1;\n" +
                "}\n",
        );
        const result = runPiFixture(fixture, {
            piCommand: fixture,
            args: [],
            cwd: workingDirectory,
            env: { SPECPI_FIXTURE_MARKER: marker },
        });
        let imported = false;
        try {
            imported = (await fs.readFile(marker, "utf8")) === "imported";
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        return { ...result, imported };
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

function assertSdkDiscoveryBlocked(result) {
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /Repository-local Pi SDK discovery requires/u);
    assert.equal(result.imported, false, "An untrusted SDK must be rejected before its module executes");
}

test("automatic SDK discovery rejects a source checkout when launched from its tests directory", async () => {
    assertSdkDiscoveryBlocked(
        await runSdkDiscoveryFixture({
            launcher: "checkout",
            sdk: "checkout/node_modules/@earendil-works/pi-coding-agent",
            cwd: "checkout/tests",
        }),
    );
});

test("automatic SDK discovery rejects a source checkout when launched from an unrelated directory", async () => {
    assertSdkDiscoveryBlocked(
        await runSdkDiscoveryFixture({
            launcher: "checkout",
            sdk: "checkout/node_modules/@earendil-works/pi-coding-agent",
            cwd: "unrelated-project",
        }),
    );
});

test("automatic SDK discovery rejects node_modules above the working directory", async () => {
    assertSdkDiscoveryBlocked(
        await runSdkDiscoveryFixture({
            launcher: "project/tools/specpi",
            sdk: "project/node_modules/@earendil-works/pi-coding-agent",
            cwd: "project/tests",
        }),
    );
});

test("automatic SDK discovery accepts an ordinary installed global sibling package", async () => {
    const result = await runSdkDiscoveryFixture({
        launcher: "global/node_modules/specpi",
        sdk: "global/node_modules/@earendil-works/pi-coding-agent",
        cwd: "unrelated-project",
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /SDK_DISCOVERY=0\.84\.4/u);
    assert.equal(result.imported, true);
});

test("automatic SDK discovery rejects a sibling package symlink into the untrusted project", async () => {
    assertSdkDiscoveryBlocked(
        await runSdkDiscoveryFixture({
            launcher: "global/node_modules/specpi",
            sdk: "global/node_modules/@earendil-works/pi-coding-agent",
            cwd: "untrusted-project",
            redirect: "untrusted-project/vendor/pi-sdk",
        }),
    );
});

test("SDK selection validates package identity and public entry before importing code", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-sdk-selection-"));
    try {
        await fs.mkdir(path.join(directory, "dist"));
        await fs.writeFile(path.join(directory, "dist", "index.js"), "throw new Error('UNREVIEWED_SDK_EXECUTED');\n");
        for (const metadata of [
            { name: "other", version: "0.84.4", exports: { ".": { import: "./dist/index.js" } } },
            {
                name: "@earendil-works/pi-coding-agent",
                version: "0.85.0",
                exports: { ".": { import: "./dist/index.js" } },
            },
            {
                name: "@earendil-works/pi-coding-agent",
                version: "0.84.4",
                exports: { ".": { import: "./private.js" } },
            },
        ]) {
            await fs.writeFile(path.join(directory, "package.json"), JSON.stringify(metadata));
            await assert.rejects(loadPiSdk({ sdkDirectory: directory }), /requires the public Pi SDK/u);
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("launcher options are explicit and proxy policies fail closed", () => {
    assert.deepEqual(parseAgentArgs([]), { help: false, trustProject: false, sdkDirectory: undefined });
    assert.equal(parseAgentArgs(["--trust-project", "--pi-sdk", path.resolve("fixture")]).trustProject, true);
    assert.throws(() => parseAgentArgs(["--pi-sdk", "relative"]), /absolute/u);
    assert.throws(() => parseAgentArgs(["--provider", "different"]), /Unsupported/u);
    const settings = { getGlobalSettings: () => ({}), getProjectSettings: () => ({}) };
    assert.doesNotThrow(() => assertSupportedProxy(settings, {}));
    assert.throws(() => assertSupportedProxy(settings, { https_proxy: "synthetic" }), /proxy environment/u);
    assert.throws(
        () => assertSupportedProxy({ ...settings, getGlobalSettings: () => ({ httpProxy: "synthetic" }) }, {}),
        /httpProxy/u,
    );
});

test("resource facade removes package installation inputs and preserves other policy", () => {
    const original = { packages: ["npm:fixture"], transport: "sse", retry: { provider: { maxRetries: 2 } } };
    const manager = {
        value: 7,
        getGlobalSettings() {
            return original;
        },
        getProjectSettings() {
            return { packages: ["npm:project"], blockImages: true };
        },
        getValue() {
            return this.value;
        },
    };
    const facade = resourceSettingsFacade(manager);
    assert.deepEqual(facade.getGlobalSettings(), { ...original, packages: [] });
    assert.deepEqual(facade.getProjectSettings(), { packages: [], blockImages: true });
    assert.deepEqual(original.packages, ["npm:fixture"]);
    assert.equal(facade.getValue(), 7);
});

test("duplicate filtering only replaces identified SpecPi resources", () => {
    const agentDir = path.resolve("fixture-agent");
    const arbitrary = path.resolve("other", "command-guard", "index.ts");
    const entries = [
        { path: path.join(agentDir, "extensions", "command-guard", "index.ts"), enabled: true },
        { path: arbitrary, enabled: true },
        {
            path: path.resolve("package", "index.ts"),
            enabled: true,
            metadata: { source: "npm:specpi@0.11.2", origin: "package" },
        },
        {
            path: path.resolve("similar", "index.ts"),
            enabled: true,
            metadata: { source: "npm:specpi-other", origin: "package" },
        },
    ];
    assert.deepEqual(selectExternalExtensions(entries, { agentDir }), [arbitrary, path.resolve("similar", "index.ts")]);
});

test("real Pi launcher blocks project discovery and retains guarded parent behavior on reload", (context) => {
    const result = runPiFixture(path.resolve("tests/fixtures/delegation-provider-harness.ts"), {
        env: {
            SPECPI_DELEGATION_FIXTURE_MODE: "launcher",
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            NO_PROXY: "",
            NODE_USE_ENV_PROXY: "",
        },
    });
    if (result.unavailable) {
        context.skip(result.error?.message ?? "Pi is unavailable");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const marker = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/u)
        .find((line) => line.startsWith("DELEGATION_FIXTURE="));
    assert.ok(marker, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(marker.slice("DELEGATION_FIXTURE=".length));
    assert.equal(report.sdkVersion, "0.84.4");
    assert.equal(report.launcher, true);
});

test("explicit Pi SDK directory runs native Node host and actual delegation", async (context) => {
    const executable = process.env.SPECPI_TEST_PI;
    if (!executable || !path.isAbsolute(executable)) {
        context.skip("Set SPECPI_TEST_PI to the pinned SDK's absolute CLI path for native import coverage");

        return;
    }

    let candidate = path.dirname(executable);
    let sdkDirectory;
    for (let depth = 0; depth < 3; depth += 1) {
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
            if (metadata.name === "@earendil-works/pi-coding-agent") {
                assert.equal(metadata.version, "0.84.4");
                assert.equal(path.resolve(candidate, metadata.bin.pi), path.resolve(executable));
                sdkDirectory = candidate;
                break;
            }
        } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
                throw error;
            }
        }

        candidate = path.dirname(candidate);
    }

    assert.ok(sdkDirectory, "SPECPI_TEST_PI must identify the pinned package's manifest CLI entry");
    const fixture = path.resolve("tests/fixtures/delegation-native-host.mjs");
    const result = runPiFixture(fixture, {
        piCommand: fixture,
        args: [],
        env: {
            SPECPI_FIXTURE_SDK_ABSOLUTE: sdkDirectory,
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            NO_PROXY: "",
            NODE_USE_ENV_PROXY: "",
        },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const marker = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("NATIVE_DELEGATION_FIXTURE="));
    assert.ok(marker, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(JSON.parse(marker.slice("NATIVE_DELEGATION_FIXTURE=".length)), {
        sdkVersion: "0.84.4",
        nativeImport: true,
        delegation: true,
        calls: 1,
    });
});

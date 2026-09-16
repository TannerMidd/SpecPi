import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT } from "../src/core.mjs";

const npm = process.env.npm_execpath;
assert.ok(npm && fs.existsSync(npm), "Run through npm run check:package.");
const args = process.argv.slice(2);
assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === "--artifact"),
    "Use --artifact <tarball> or no arguments.",
);
const suppliedArtifact = args.length ? path.resolve(args[1]) : undefined;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-pack-"));
const env = {
    ...process.env,
    npm_config_cache: path.join(temporary, "npm-cache"),
    npm_config_userconfig: path.join(temporary, "npmrc"),
};
fs.writeFileSync(env.npm_config_userconfig, "");

function run(args, cwd = temporary) {
    const result = spawnSync(process.execPath, args, {
        cwd,
        env,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    return result.stdout;
}

try {
    const [packed] = suppliedArtifact
        ? [{ filename: suppliedArtifact }]
        : JSON.parse(run([npm, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary], PACKAGE_ROOT));
    const artifact = suppliedArtifact ?? path.join(temporary, packed.filename);
    fs.writeFileSync(path.join(temporary, "package.json"), '{"private":true,"type":"module"}');
    run([npm, "install", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", artifact]);
    const installed = path.join(temporary, "node_modules", "specpi-browser-qa");
    const installedManifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    for (const key of ["name", "version", "dependencies", "peerDependencies", "pi"]) {
        assert.deepEqual(installedManifest[key], sourceManifest[key], `Artifact ${key} differs from reviewed source`);
    }

    const files = fs
        .readdirSync(installed, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(installed, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .filter((file) => !file.startsWith("node_modules/"));
    for (const expected of [
        "src/index.ts",
        "src/core.mjs",
        "src/activation.mjs",
        "src/activation.d.mts",
        "src/core.d.mts",
        "src/smoke.mjs",
        "bin/browser-qa.mjs",
        "README.md",
        "SECURITY.md",
        "THIRD_PARTY.md",
        "LICENSE",
    ]) {
        assert.ok(files.includes(expected), expected);
    }

    assert.ok(
        files.every((file) =>
            /^(?:src\/|bin\/|package.json$|README.md$|SECURITY.md$|THIRD_PARTY.md$|LICENSE$)/u.test(file),
        ),
        files.join("\n"),
    );
    for (const file of files.filter((file) => file !== "package.json")) {
        const text = (root) => fs.readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
        assert.equal(text(installed), text(PACKAGE_ROOT), `Artifact content differs: ${file}`);
    }

    assert.match(run([path.join(installed, "bin", "browser-qa.mjs"), "--help"]), /No Bun required/u);
    run([path.join(installed, "bin", "browser-qa.mjs"), "doctor"]);

    // Load the tarball's entry point through real Pi, with no live configuration or model requests.
    const fixture = path.join(temporary, "registration.ts");
    fs.writeFileSync(
        fixture,
        `import register from ${JSON.stringify(path.join(installed, "src", "index.ts"))};
export default function(pi) {
    let count = 0;
    const commands = [];
    register({ ...pi,
        registerTool(tool) { count++; pi.registerTool(tool); },
        registerCommand(name, command) { commands.push(name); pi.registerCommand(name, command); },
        on(event, handler) { pi.on(event, handler); } });
    pi.on("session_start", () => {
        // The tools are registered but gated, so the packaged extension must offer none of
        // them until /browser turns them on.
        const active = pi.getActiveTools().filter((name) => name.startsWith("browser_"));
        console.log("PACKAGED_BROWSER_TOOLS=" + JSON.stringify({ count, commands, active: active.length }));
    });
}`,
    );
    const piCli = path.join(
        path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
        "cli.js",
    );
    const agent = path.join(temporary, "agent");
    fs.mkdirSync(agent);
    const piEnv = Object.fromEntries(
        Object.entries(env).filter(
            ([name]) =>
                !/^(?:PI_|SPECPI_|XDG_|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)/iu.test(name) &&
                !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name),
        ),
    );
    Object.assign(piEnv, {
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        HOME: temporary,
        USERPROFILE: temporary,
        APPDATA: path.join(temporary, "roaming"),
        LOCALAPPDATA: path.join(temporary, "local"),
    });
    const result = spawnSync(
        process.execPath,
        [
            piCli,
            "--mode",
            "rpc",
            "--offline",
            "--no-session",
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
            "-e",
            fixture,
        ],
        {
            cwd: temporary,
            env: piEnv,
            encoding: "utf8",
            input: '{"type":"get_state"}\n',
            timeout: 60000,
            windowsHide: true,
        },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // Pi may route extension console output to stderr to keep RPC stdout protocol-only.
    const marker = (result.stdout + result.stderr)
        .split(/\r?\n/u)
        .find((line) => line.includes("PACKAGED_BROWSER_TOOLS="));
    assert.ok(marker, result.stdout + result.stderr);
    assert.deepEqual(
        JSON.parse(marker.slice(marker.indexOf("PACKAGED_BROWSER_TOOLS=") + "PACKAGED_BROWSER_TOOLS=".length)),
        { count: 14, commands: ["browser"], active: 0 },
    );
    console.log("Production tarball: dependency resolution, offline doctor, and Pi registration passed.");
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}

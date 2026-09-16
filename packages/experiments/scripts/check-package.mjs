import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
assert.ok(npm && fs.existsSync(npm), "Run through npm run check:package.");
const args = process.argv.slice(2);
assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === "--artifact"),
    "Use --artifact <tarball> or no arguments.",
);
const suppliedArtifact = args.length ? path.resolve(args[1]) : undefined;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "experiments-pack-"));
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
    const installed = path.join(temporary, "node_modules", "specpi-experiments");
    const installedManifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    for (const key of ["name", "version", "dependencies", "peerDependencies", "pi"]) {
        assert.deepEqual(installedManifest[key], sourceManifest[key], `Artifact ${key} differs from reviewed source`);
    }

    // Experiments carries no production dependencies; a stray one would ship unreviewed code.
    assert.equal(installedManifest.dependencies, undefined, "Experiments must have no production dependencies");
    assert.equal(
        fs.existsSync(path.join(installed, "node_modules")),
        false,
        "Experiments must install no transitive packages",
    );

    const files = fs
        .readdirSync(installed, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(installed, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
    for (const expected of [
        "src/index.ts",
        "src/card.mjs",
        "src/card.d.mts",
        "src/experiments.mjs",
        "src/experiments.d.mts",
        "src/git-status.mjs",
        "src/git-status.d.mts",
        "README.md",
        "SECURITY.md",
        "THIRD_PARTY.md",
        "LICENSE",
    ]) {
        assert.ok(files.includes(expected), expected);
    }

    assert.ok(
        files.every((file) => /^(?:src\/|package.json$|README.md$|SECURITY.md$|THIRD_PARTY.md$|LICENSE$)/u.test(file)),
        files.join("\n"),
    );
    for (const file of files.filter((file) => file !== "package.json")) {
        const text = (root) => fs.readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
        assert.equal(text(installed), text(PACKAGE_ROOT), `Artifact content differs: ${file}`);
    }

    // Load the tarball's entry point through real Pi, with no live configuration or model requests.
    const fixture = path.join(temporary, "registration.ts");
    fs.writeFileSync(
        fixture,
        `import register from ${JSON.stringify(path.join(installed, "src", "index.ts"))};
export default function(pi) {
    const tools = [];
    const commands = [];
    register({
        ...pi,
        registerTool(tool) { tools.push(tool.name); pi.registerTool(tool); },
        registerCommand(name, command) { commands.push(name); pi.registerCommand(name, command); },
    });
    pi.on("session_start", () => {
        console.log("PACKAGED_EXPERIMENTS=" + JSON.stringify({ tools, commands }));
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
        .find((line) => line.includes("PACKAGED_EXPERIMENTS="));
    assert.ok(marker, result.stdout + result.stderr);
    assert.deepEqual(
        JSON.parse(marker.slice(marker.indexOf("PACKAGED_EXPERIMENTS=") + "PACKAGED_EXPERIMENTS=".length)),
        {
            tools: [],
            commands: ["experiment"],
        },
    );
    console.log("Production tarball: dependency isolation, file manifest, and Pi registration passed.");
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}

// The bug these cover: on Windows an npm-installed `pi` is really `pi.cmd`,
// and bare spawn("pi") fails with ENOENT. The integration suites cannot catch
// it because they spawn node.exe, a real executable, so PATH resolution of a
// batch shim is never exercised there.
//
// Windows paths are assembled from SEP rather than written as literals, so no
// backslash escaping in this file can quietly change what is being asserted.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnTarget, quoteForCmd } from "../src/spawn-target.js";

const SEP = String.fromCharCode(92);
const win = (...parts) => parts.join(SEP);

const NPM_DIR = win("C:", "Users", "dev", "AppData", "Roaming", "npm");
const TOOLS_DIR = win("C:", "tools");
const CMD_EXE = win("C:", "Windows", "system32", "cmd.exe");

const WINDOWS_ENV = {
    PATH: `${TOOLS_DIR};${NPM_DIR}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: CMD_EXE,
};

// Mirrors a real npm install: a bare shell shim next to the .cmd Windows uses.
const npmLayout = (paths) => (candidate) => paths.includes(candidate);

const RPC_ARGS = ["--mode", "rpc"];

test("POSIX passes the command straight through", () => {
    const target = spawnTarget("pi", RPC_ARGS, { platform: "linux", env: { PATH: "/usr/bin" } });
    assert.deepEqual(target, { file: "pi", args: RPC_ARGS, options: {} });
});

test("Windows routes an npm .cmd shim through cmd.exe", () => {
    const exists = npmLayout([win(NPM_DIR, "pi"), win(NPM_DIR, "pi.cmd")]);
    const target = spawnTarget("pi", RPC_ARGS, { platform: "win32", env: WINDOWS_ENV, exists });

    assert.equal(target.file, CMD_EXE);
    assert.deepEqual(target.args, ["/d", "/s", "/c", `"${win(NPM_DIR, "pi.cmd")} --mode rpc"`]);
    assert.equal(target.options.windowsVerbatimArguments, true);
});

test("the extensionless npm shim never shadows the .cmd", () => {
    // The bare `pi` file exists and sorts first, but Windows cannot run it.
    // Picking it is precisely the original bug.
    const exists = npmLayout([win(NPM_DIR, "pi"), win(NPM_DIR, "pi.cmd")]);
    const target = spawnTarget("pi", RPC_ARGS, { platform: "win32", env: WINDOWS_ENV, exists });
    assert.ok(target.args[3].includes("pi.cmd"), "must resolve the .cmd, not the shell shim");
});

test("a real .exe is spawned directly, with no shell in the way", () => {
    const exists = npmLayout([win(TOOLS_DIR, "pi.exe")]);
    const target = spawnTarget("pi", RPC_ARGS, { platform: "win32", env: WINDOWS_ENV, exists });
    assert.equal(target.file, win(TOOLS_DIR, "pi.exe"));
    assert.deepEqual(target.args, RPC_ARGS);
    assert.deepEqual(target.options, {});
});

test("PATH order decides between two installs", () => {
    const exists = npmLayout([win(TOOLS_DIR, "pi.cmd"), win(NPM_DIR, "pi.cmd")]);
    const target = spawnTarget("pi", RPC_ARGS, { platform: "win32", env: WINDOWS_ENV, exists });
    assert.equal(target.args[3], `"${win(TOOLS_DIR, "pi.cmd")} --mode rpc"`);
});

test("an explicit path is used without searching PATH", () => {
    const explicit = win("C:", "custom", "build", "pi.cmd");
    const target = spawnTarget(explicit, RPC_ARGS, {
        platform: "win32",
        env: WINDOWS_ENV,
        exists: npmLayout([explicit]),
    });
    assert.equal(target.args[3], `"${explicit} --mode rpc"`);
});

test("a path with spaces stays quoted for cmd.exe", () => {
    const spaced = win("C:", "Program Files", "pi", "pi.cmd");
    const target = spawnTarget(spaced, RPC_ARGS, {
        platform: "win32",
        env: WINDOWS_ENV,
        exists: npmLayout([spaced]),
    });
    // Inner quotes around the path, outer quotes around the whole command line.
    assert.equal(target.args[3], `""${spaced}" --mode rpc"`);
});

test("an unresolvable command falls back so spawn reports the real name", () => {
    const target = spawnTarget("nope", RPC_ARGS, {
        platform: "win32",
        env: WINDOWS_ENV,
        exists: () => false,
    });
    assert.deepEqual(target, { file: "nope", args: RPC_ARGS, options: {} });
});

test("quoteForCmd wraps anything cmd.exe would reinterpret", () => {
    assert.equal(quoteForCmd("plain"), "plain");
    assert.equal(quoteForCmd("--mode"), "--mode");
    assert.equal(quoteForCmd("has space"), '"has space"');
    for (const hostile of ["a&b", "a|b", "a^b", "a>b", "a<b", "a%b", "a!b", "a(b)"]) {
        assert.equal(quoteForCmd(hostile), `"${hostile}"`, `${hostile} must be quoted`);
    }
});

test("quoteForCmd doubles an embedded quote rather than letting it escape", () => {
    assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});

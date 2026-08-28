import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENTS_END,
  AGENTS_START,
  deletePath,
  mergePackages,
  packageIdentity,
  readPath,
  removeManagedBlock,
  setPath,
  sha256,
  upsertManagedBlock,
} from "../scripts/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "scripts", "zenpi.mjs");

function invokeCli(agentDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
}

function runCli(agentDir, ...args) {
  const result = invokeCli(agentDir, args);
  if (result.status !== 0) {
    throw new Error(`zenpi ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

test("npm package identities ignore pinned versions", () => {
  assert.equal(packageIdentity("npm:pi-subagents@0.58.0"), "npm:pi-subagents");
  assert.equal(
    packageIdentity("npm:@scope/example@1.2.3"),
    "npm:@scope/example",
  );
  assert.equal(packageIdentity({ source: "npm:@scope/example" }), "npm:@scope/example");
});

test("package merge replaces matching identities and preserves unrelated entries", () => {
  const existing = [
    "npm:other@1.0.0",
    { source: "npm:pi-subagents@0.1.0", skills: [] },
  ];
  assert.deepEqual(mergePackages(existing, ["npm:pi-subagents@0.58.0"]), [
    "npm:other@1.0.0",
    "npm:pi-subagents@0.58.0",
  ]);
});

test("managed blocks preserve surrounding user content", () => {
  const installed = upsertManagedBlock("before\nafter\n", AGENTS_START, AGENTS_END, "managed v1");
  assert.match(installed, /before\nafter/);
  assert.match(installed, /managed v1/);

  const updated = upsertManagedBlock(installed, AGENTS_START, AGENTS_END, "managed v2");
  assert.doesNotMatch(updated, /managed v1/);
  assert.match(updated, /managed v2/);
  assert.equal(removeManagedBlock(updated, AGENTS_START, AGENTS_END), "before\nafter\n");
});

test("path operations create, read, and prune empty parents", () => {
  const value = {};
  setPath(value, ["one", "two", "three"], 3);
  assert.deepEqual(readPath(value, ["one", "two", "three"]), { exists: true, value: 3 });
  deletePath(value, ["one", "two", "three"]);
  assert.deepEqual(value, {});
});

test("install, update, doctor, and uninstall round trip in an isolated agent dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-test-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });

  const originalSettings = {
    defaultProvider: "openrouter",
    defaultModel: "example/model",
    packages: ["npm:other@1.0.0", "npm:pi-web-access@0.1.0"],
    subagents: {
      defaultModel: "legacy/provider-model",
      customSetting: true,
    },
  };
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(originalSettings, null, 2)}\n`);
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "# Personal instructions\n");
  fs.writeFileSync(path.join(agentDir, "extensions", "zen.ts"), "// personal prior zen\n");

  try {
    runCli(agentDir, "install", "--yes", "--skip-package-install", "--skip-shell");
    const installed = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(installed.defaultProvider, "openrouter");
    assert.equal(installed.defaultModel, "example/model");
    assert.equal(installed.subagents.defaultModel, undefined);
    assert.deepEqual(installed.subagents.modelScope, {
      enforce: true,
      strict: true,
      allow: ["inherit"],
    });
    assert.equal(installed.subagents.agentOverrides.worker.model, "inherit");
    assert.equal(installed.subagents.agentOverrides["codex-exec"].disabled, true);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")));
    assert.match(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), /# Personal instructions/);

    const fakeBin = path.join(root, "bin");
    writeExecutable(path.join(fakeBin, "pi"), "#!/bin/sh\nexit 0\n");
    const doctor = invokeCli(agentDir, ["doctor"], {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    assert.equal(doctor.status, 0, doctor.stderr);

    // Simulate ownership retired by a future ZenPi version.
    const retiredFile = path.join(agentDir, "extensions", "retired.ts");
    fs.writeFileSync(retiredFile, "// retired\n");
    const beforeUpdateSettings = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    );
    beforeUpdateSettings.subagents.retiredFlag = true;
    beforeUpdateSettings.packages.push("npm:retired-zenpi-package@1.0.0");
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(beforeUpdateSettings, null, 2)}\n`,
    );
    const manifestPath = path.join(agentDir, "zenpi", "manifest.json");
    const beforeUpdateManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    beforeUpdateManifest.settingsChanges.push({
      path: ["subagents", "retiredFlag"],
      beforeExists: false,
      installedExists: true,
      installed: true,
    });
    beforeUpdateManifest.packageChanges.push({
      identity: "npm:retired-zenpi-package",
      beforeExists: false,
      installed: "npm:retired-zenpi-package@1.0.0",
    });
    beforeUpdateManifest.files[retiredFile] = {
      existed: false,
      installedHash: sha256(fs.readFileSync(retiredFile)),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(beforeUpdateManifest, null, 2)}\n`);

    runCli(agentDir, "update", "--yes", "--skip-package-install", "--skip-shell");
    const afterUpdate = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(afterUpdate.subagents.retiredFlag, undefined);
    assert.equal(
      afterUpdate.packages.some((entry) => String(entry).includes("retired-zenpi-package")),
      false,
    );
    assert.equal(fs.existsSync(retiredFile), false);

    runCli(agentDir, "uninstall", "--yes");

    const restored = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(restored, originalSettings);
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), "# Personal instructions\n");
    assert.equal(
      fs.readFileSync(path.join(agentDir, "extensions", "zen.ts"), "utf8"),
      "// personal prior zen\n",
    );
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default package and shell paths work with an isolated fake pi", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-shell-test-"));
  const agentDir = path.join(root, "agent");
  const shellRc = path.join(root, ".bashrc");
  const fakeBin = path.join(root, "bin");
  const log = path.join(root, "pi.log");
  writeExecutable(
    path.join(fakeBin, "pi"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ZENPI_FAKE_LOG\"\nexit 0\n",
  );
  fs.writeFileSync(shellRc, "# personal shell\n");
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    SHELL: "/bin/bash",
    ZENPI_SHELL_RC: shellRc,
    ZENPI_FAKE_LOG: log,
  };

  try {
    const install = invokeCli(agentDir, ["install", "--yes"], env);
    assert.equal(install.status, 0, install.stderr);
    const shell = fs.readFileSync(shellRc, "utf8");
    assert.match(shell, /# >>> ZenPi >>>/);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "pi-profiles.sh")));
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.filter((line) => line.startsWith("install ")).length, 7);
    assert.ok(calls.some((line) => line.startsWith("--offline --list-models")));

    const update = invokeCli(
      agentDir,
      ["update", "--yes", "--skip-package-install", "--skip-shell"],
      env,
    );
    assert.equal(update.status, 0, update.stderr);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "pi-profiles.sh")));
    assert.match(fs.readFileSync(shellRc, "utf8"), /# >>> ZenPi >>>/);

    const uninstall = invokeCli(agentDir, ["uninstall", "--yes"], env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.readFileSync(shellRc, "utf8"), "# personal shell\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed package installation rolls configuration back and releases the lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-failure-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  const settingsPath = path.join(agentDir, "settings.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(settingsPath, '{"untouched":true}\n');
  writeExecutable(
    path.join(fakeBin, "pi"),
    "#!/bin/sh\ncase \"$*\" in *pi-subagents*) exit 9;; esac\nexit 0\n",
  );
  const env = { PATH: `${fakeBin}:${process.env.PATH}`, SHELL: "/bin/bash" };

  try {
    const result = invokeCli(agentDir, ["install", "--yes", "--skip-shell"], env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { untouched: true });
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "install.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings symlinks remain symlinks through install and uninstall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-symlink-test-"));
  const agentDir = path.join(root, "agent");
  const target = path.join(root, "settings-target.json");
  const link = path.join(agentDir, "settings.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(target, '{"kept":true}\n');
  fs.symlinkSync(target, link);

  try {
    runCli(agentDir, "install", "--yes", "--skip-package-install", "--skip-shell");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    runCli(agentDir, "uninstall", "--yes");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { kept: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty AGENTS and shell symlink targets remain linked after uninstall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-block-symlink-test-"));
  const agentDir = path.join(root, "agent");
  const agentsTarget = path.join(root, "AGENTS-target.md");
  const shellTarget = path.join(root, "shell-target.rc");
  const agentsLink = path.join(agentDir, "AGENTS.md");
  const shellLink = path.join(root, ".bashrc");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(agentsTarget, "");
  fs.writeFileSync(shellTarget, "");
  fs.symlinkSync(agentsTarget, agentsLink);
  fs.symlinkSync(shellTarget, shellLink);
  const env = { SHELL: "/bin/bash", ZENPI_SHELL_RC: shellLink };

  try {
    const install = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install"],
      env,
    );
    assert.equal(install.status, 0, install.stderr);
    const uninstall = invokeCli(agentDir, ["uninstall", "--yes"], env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.lstatSync(agentsLink).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(shellLink).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(agentsTarget, "utf8"), "");
    assert.equal(fs.readFileSync(shellTarget, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broken managed-path symlinks fail without leaving a lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-broken-link-test-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.symlinkSync(path.join(root, "missing-settings.json"), path.join(agentDir, "settings.json"));

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install", "--skip-shell"],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Broken symlink is unsupported/);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "install.lock")), false);
    assert.equal(fs.lstatSync(path.join(agentDir, "settings.json")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

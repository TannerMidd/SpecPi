import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyPath, pathDecision } from "../extensions/command-guard/paths.mjs";

test("Unix protected mutation paths are lexical and do not require enumeration", () => {
  assert.equal(classifyPath("/", { platform: "linux", cwd: "/tmp" }).protected, true);
  assert.equal(classifyPath("/etc/passwd", { platform: "linux", cwd: "/tmp" }).protected, true);
  assert.equal(classifyPath("/workspace/src/file.txt", { platform: "linux", cwd: "/tmp" }).protected, false);
});
test("recognized private reads deny lexically without probing filesystem metadata", () => {
  const original = fs.realpathSync;
  let calls = 0;
  fs.realpathSync = Object.assign(() => { calls += 1; throw new Error("metadata probe"); }, { native: () => { calls += 1; throw new Error("metadata probe"); } });
  try {
    const result = classifyPath("/home/alice/.ssh/id_ed25519", { platform: "linux", cwd: "/tmp", read: true });
    assert.equal(result.protected, true); assert.equal(calls, 0);
  } finally { fs.realpathSync = original; }
});

test("read protection is limited to credential/private state", () => {
  assert.equal(classifyPath("/etc/hosts", { platform: "linux", cwd: "/tmp", read: true }).protected, false);
  assert.equal(classifyPath("/home/alice/.ssh/id_ed25519", { platform: "linux", cwd: "/tmp", read: true }).protected, true);
  assert.equal(pathDecision("/home/alice/.ssh/id_ed25519", "read", { platform: "linux", cwd: "/tmp" }).action, "deny");
});
test("Windows roots, device paths, and ADS are protected", () => {
  assert.equal(classifyPath("C:\\", { platform: "win32", cwd: "C:\\work" }).protected, true);
  assert.equal(classifyPath("C:\\Windows\\System32", { platform: "win32", cwd: "C:\\work" }).protected, true);
  assert.equal(classifyPath("c:/wInDoWs/system32", { platform: "win32", cwd: "C:\\work" }).protected, true);
  assert.equal(classifyPath("\\\\?\\C:\\Windows", { platform: "win32", cwd: "C:\\work" }).device, true);
  assert.equal(classifyPath("C:\\work\\file.txt", { platform: "win32", cwd: "C:\\work" }).protected, false);
  assert.equal(classifyPath("C:\\work\\file.txt:secret", { platform: "win32", cwd: "C:\\work" }).ads, true);
  assert.equal(classifyPath("\\\\server\\share", { platform: "win32", cwd: "C:\\work" }).protected, true);
});
test("Windows Bash classifies MSYS drive and home syntax with Win32 semantics", () => {
  assert.equal(classifyPath("/c/Windows", { platform: "win32", shell: "bash", cwd: "C:\\work" }).protected, true);
  assert.equal(classifyPath("/cygdrive/c/Users", { platform: "win32", shell: "bash", cwd: "C:\\work" }).protected, true);
  assert.equal(classifyPath("/d/work/project", { platform: "win32", shell: "bash", cwd: "D:\\work\\project" }).withinWorkspace, true);
});

test("dot segments normalize against cwd", () => {
  const result = classifyPath("src/../file.txt", { platform: "linux", cwd: "/tmp/work" });
  assert.equal(result.lexical, "/tmp/work/file.txt");
});

test("ordinary profile-contained and UNC workspaces remain usable", () => {
  const unix = classifyPath("src/file.ts", { platform: "linux", cwd: "/home/alice/project" });
  assert.equal(unix.protected, false);
  assert.equal(unix.withinWorkspace, true);
  const windows = classifyPath("src\\file.ts", { platform: "win32", cwd: "C:\\Users\\Alice\\project" });
  assert.equal(windows.protected, false);
  assert.equal(windows.withinWorkspace, true);
  const unc = classifyPath("src\\file.ts", { platform: "win32", cwd: "\\\\server\\share\\project" });
  assert.equal(unc.protected, false);
  assert.equal(unc.withinWorkspace, true);
});

test("canonicalization detects a workspace symlink escaping outside", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-path-symlink-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
    const result = classifyPath(path.join(workspace, "link", "new.txt"), { platform: process.platform, cwd: workspace });
    assert.equal(result.withinWorkspace, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("canonical checks observe a symlink target changed between analyses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-path-race-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const target = path.join(workspace, "target");
    fs.mkdirSync(target, { recursive: true }); fs.mkdirSync(outside);
    assert.equal(classifyPath(path.join(target, "new.txt"), { platform: process.platform, cwd: workspace }).withinWorkspace, true);
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
    assert.equal(classifyPath(path.join(target, "new.txt"), { platform: process.platform, cwd: workspace }).withinWorkspace, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("common package and container credentials are protected reads", () => {
  for (const value of ["/home/alice/.npmrc", "/home/alice/.netrc", "/home/alice/.pypirc", "/home/alice/.docker/config.json", "/home/alice/.gnupg/private-keys-v1.d/key", "/home/alice/.config/gcloud/application_default_credentials.json", "C:\\Users\\Alice\\.kube\\config", "C:\\Windows\\System32\\config\\SAM", "C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Credentials\\credential", "C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data"]) {
    const platform = value.startsWith("C:") ? "win32" : "linux";
    assert.equal(classifyPath(value, { platform, cwd: platform === "win32" ? "C:\\work" : "/tmp", read: true }).protected, true, value);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyPath, isAgentPath, pathDecision } from "../extensions/command-guard/paths.mjs";

test("Unix protected mutation paths are lexical and do not require enumeration", () => {
    assert.equal(classifyPath("/", { platform: "linux", cwd: "/tmp" }).protected, true);
    assert.equal(classifyPath("/etc/passwd", { platform: "linux", cwd: "/tmp" }).protected, true);
    assert.equal(classifyPath("/workspace/src/file.txt", { platform: "linux", cwd: "/tmp" }).protected, false);
});
test("agent-private state is identified by location, not by name appearing in a path", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agent = process.platform === "win32" ? "C:\\agent" : "/opt/agent";
    const sep = process.platform === "win32" ? "\\" : "/";
    const options = { cwd: process.platform === "win32" ? "C:\\work" : "/work" };
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
        // Installed state stays protected for reads and writes alike.
        for (const relative of [
            "zenpi/manifest.json",
            "zenpi/backups/001.json",
            "zenpi/wishlist/state.json",
            "zenpi/subagent-provider-profiles.json",
            "auth.json",
            "sessions/abc.json",
            "history.db",
            "trust.json",
        ]) {
            const target = `${agent}${sep}${relative.replaceAll("/", sep)}`;
            assert.equal(classifyPath(target, { ...options, read: true }).protected, true, `read ${relative}`);
            assert.equal(classifyPath(target, options).protected, true, `write ${relative}`);
        }

        // Installed guard sources are a tamper target; reading them is not secret.
        const guardSource = `${agent}${sep}extensions${sep}command-guard${sep}rules.mjs`;
        assert.equal(classifyPath(guardSource, options).protected, true);
        assert.equal(classifyPath(guardSource, { ...options, read: true }).protected, false);
        assert.equal(isAgentPath(guardSource, options), true);

        // A checkout that merely contains these names is ordinary work — this is ZenPi's own source tree.
        for (const relative of [
            "zenpi/manifest.json",
            "extensions/command-guard/rules.mjs",
            "zenpi/wishlist/state.json",
        ]) {
            assert.equal(classifyPath(relative, { ...options, read: true }).protected, false, `read ${relative}`);
            assert.equal(classifyPath(relative, options).protected, false, `write ${relative}`);
            assert.equal(isAgentPath(relative, options), false, relative);
        }
    } finally {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previous;
        }
    }
});

test("ordinary project paths are not mistaken for Pi private state", () => {
    // The POSIX rule used to be an unanchored /(?:zenpi|pi).*(?:auth|session|…)/, so "pi" inside "api" plus a
    // later "session" or "auth" denied everyday source files critically and locked the session.
    const unix = { platform: "linux", cwd: "/home/dev/app" };
    for (const target of [
        "/home/dev/app/src/api/session.ts",
        "/home/dev/app/src/api/sessions/index.js",
        "/home/dev/app/lib/api/auth.py",
        "/home/dev/app/docs/api/authentication.md",
        "/home/dev/app/src/pipeline/mission-control.ts",
        "/home/dev/app/spi/history.go",
        "/home/dev/app/src/components/Trustpilot.tsx",
        "/home/dev/app/api/private/index.ts",
    ]) {
        assert.equal(classifyPath(target, unix).protected, false, target);
        assert.equal(pathDecision(target, unix).action, "allow", target);
    }

    // A .pi directory is still Pi state wherever it lives.
    assert.equal(classifyPath("/home/dev/app/.pi/settings.json", { ...unix, read: true }).protected, true);
});

test("macOS system roots are protected without swallowing the user data tree", () => {
    const mac = { platform: "darwin", cwd: "/Users/alice/work" };
    for (const target of [
        "/System",
        "/System/Library/LaunchDaemons",
        "/Library",
        "/Library/LaunchAgents/x.plist",
        "/Applications",
        "/Applications/Xcode.app",
        "/Users",
        "/Users/alice",
        "/Volumes",
        "/Volumes/Backup",
        "/private",
        "/private/etc/hosts",
        "/private/var/db",
        "/cores",
        "/Users/alice/.zshenv",
        "/Users/alice/.bash_profile",
        "/Users/alice/.zprofile",
    ]) {
        assert.equal(classifyPath(target, mac).protected, true, target);
    }

    // Firmlinked user data lives under /System/Volumes/Data; only the volume root itself is system state.
    assert.equal(classifyPath("/System/Volumes/Data", mac).protected, true);
    for (const target of [
        "/Users/alice/work/src/file.ts",
        "/Users/alice/work",
        "/Volumes/Backup/projects/app",
        "/System/Volumes/Data/Users/alice/work/src/file.ts",
        "/private/tmp/scratch",
        "/tmp/scratch",
        "/Applications2",
        "/Libraryish/notes.md",
    ]) {
        assert.equal(classifyPath(target, mac).protected, false, target);
    }

    assert.equal(pathDecision("/Library/LaunchDaemons/x.plist", mac).action, "deny");
    assert.equal(pathDecision("/Users/alice/work/src/file.ts", mac).action, "allow");
});
test("process environment and memory pseudo-files are protected reads", () => {
    const linux = { platform: "linux", cwd: "/home/alice/work", read: true };
    for (const target of ["/proc/self/environ", "/proc/1/environ", "/proc/thread-self/environ", "/proc/4242/mem"]) {
        assert.equal(classifyPath(target, linux).protected, true, target);
    }

    for (const target of ["/proc/self/status", "/proc/cpuinfo", "/home/alice/work/proc/self/environ"]) {
        assert.equal(classifyPath(target, linux).protected, false, target);
    }
});
test("recognized private reads deny lexically without probing filesystem metadata", () => {
    const original = fs.realpathSync;
    let calls = 0;
    fs.realpathSync = Object.assign(
        () => {
            calls += 1;
            throw new Error("metadata probe");
        },
        {
            native: () => {
                calls += 1;
                throw new Error("metadata probe");
            },
        },
    );
    try {
        const result = classifyPath("/home/alice/.ssh/id_ed25519", { platform: "linux", cwd: "/tmp", read: true });
        assert.equal(result.protected, true);
        assert.equal(calls, 0);
    } finally {
        fs.realpathSync = original;
    }
});

test("read protection is limited to credential/private state", () => {
    assert.equal(classifyPath("/etc/hosts", { platform: "linux", cwd: "/tmp", read: true }).protected, false);
    assert.equal(
        classifyPath("/home/alice/.ssh/id_ed25519", { platform: "linux", cwd: "/tmp", read: true }).protected,
        true,
    );
    assert.equal(
        pathDecision("/home/alice/.ssh/id_ed25519", "read", { platform: "linux", cwd: "/tmp" }).action,
        "deny",
    );
});

test("Guard protects host and enforcement mutation, not ordinary private files", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/agent";
    const guard = { platform: "linux", cwd: "/work", mode: "guard" };
    try {
        assert.equal(classifyPath("/home/alice/.ssh/id_ed25519", guard).protected, false);
        assert.equal(classifyPath("/home/alice/.ssh/id_ed25519", { ...guard, mode: "strict" }).protected, false);
        assert.equal(classifyPath("/etc/passwd", guard).protected, true);
        assert.equal(classifyPath("/etc/unused-review-note", guard).protected, false);
        assert.equal(classifyPath("/opt/myapp/config.json", guard).protected, false);
        assert.equal(classifyPath("/opt/myapp/config.json", { ...guard, mode: "strict" }).protected, false);
        assert.equal(classifyPath("/tmp/agent/settings.json", guard).protected, true);
        assert.equal(classifyPath("/tmp/agent/extensions/command-guard/index.ts", guard).protected, true);
        assert.equal(classifyPath("/tmp/agent/auth.json", guard).protected, false);
    } finally {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previous;
        }
    }
});
test("Windows roots, device paths, and ADS are protected", () => {
    assert.equal(classifyPath("C:\\", { platform: "win32", cwd: "C:\\work" }).protected, true);
    assert.equal(classifyPath("C:\\Windows\\System32", { platform: "win32", cwd: "C:\\work" }).protected, true);
    assert.equal(classifyPath("c:/wInDoWs/system32", { platform: "win32", cwd: "C:\\work" }).protected, true);
    assert.equal(classifyPath("\\\\?\\C:\\Windows", { platform: "win32", cwd: "C:\\work" }).device, true);
    assert.equal(classifyPath("C:\\work\\file.txt", { platform: "win32", cwd: "C:\\work" }).protected, false);
    assert.equal(
        classifyPath("C:\\Windows\\unused-review-note", { platform: "win32", cwd: "C:\\work", mode: "guard" })
            .protected,
        false,
    );
    assert.equal(
        classifyPath("C:\\Windows\\System32\\config\\SAM", { platform: "win32", cwd: "C:\\work", mode: "guard" })
            .protected,
        true,
    );
    assert.equal(classifyPath("C:\\work\\file.txt:secret", { platform: "win32", cwd: "C:\\work" }).ads, true);
    assert.equal(classifyPath("\\\\server\\share", { platform: "win32", cwd: "C:\\work" }).protected, true);
});
test("Windows Bash classifies MSYS drive and home syntax with Win32 semantics", () => {
    assert.equal(classifyPath("/c/Windows", { platform: "win32", shell: "bash", cwd: "C:\\work" }).protected, true);
    assert.equal(
        classifyPath("/cygdrive/c/Users", { platform: "win32", shell: "bash", cwd: "C:\\work" }).protected,
        true,
    );
    assert.equal(
        classifyPath("/d/work/project", { platform: "win32", shell: "bash", cwd: "D:\\work\\project" }).withinWorkspace,
        true,
    );
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
    const namedZenPi = classifyPath("D:\\a\\ZenPi\\ZenPi\\$TARGET", { platform: "win32", cwd: "D:\\a\\ZenPi\\ZenPi" });
    assert.equal(namedZenPi.protected, false);
    assert.equal(
        classifyPath("D:\\a\\ZenPi\\ZenPi\\README.md", { platform: "win32", cwd: "D:\\a\\ZenPi\\ZenPi", read: true })
            .protected,
        false,
    );
});

test("canonicalization detects a workspace symlink escaping outside", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-path-symlink-"));
    try {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        fs.mkdirSync(workspace);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
        const result = classifyPath(path.join(workspace, "link", "new.txt"), {
            platform: process.platform,
            cwd: workspace,
        });
        assert.equal(result.withinWorkspace, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("canonical checks observe a symlink target changed between analyses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-path-race-"));
    try {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        const target = path.join(workspace, "target");
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(outside);
        assert.equal(
            classifyPath(path.join(target, "new.txt"), { platform: process.platform, cwd: workspace }).withinWorkspace,
            true,
        );
        fs.rmSync(target, { recursive: true });
        fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
        assert.equal(
            classifyPath(path.join(target, "new.txt"), { platform: process.platform, cwd: workspace }).withinWorkspace,
            false,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("common package and container credentials are protected reads", () => {
    for (const value of [
        "/home/alice/.npmrc",
        "/home/alice/.netrc",
        "/home/alice/.pypirc",
        "/home/alice/.docker/config.json",
        "/home/alice/.gnupg/private-keys-v1.d/key",
        "/home/alice/.config/gcloud/application_default_credentials.json",
        "C:\\Users\\Alice\\.kube\\config",
        "C:\\Windows\\System32\\config\\SAM",
        "C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Credentials\\credential",
        "C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data",
    ]) {
        const platform = value.startsWith("C:") ? "win32" : "linux";
        assert.equal(
            classifyPath(value, { platform, cwd: platform === "win32" ? "C:\\work" : "/tmp", read: true }).protected,
            true,
            value,
        );
    }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
    MAX_LOG_BYTES,
    MAX_RUNNING_JOBS,
    admission,
    completionText,
    createJobManager,
    effectiveShellMapping,
    guardEnabled,
    listText,
    mappingGatesCommand,
    pruneStaleLogs,
    readJsonc,
    tailOf,
    widgetPayload,
} from "../extensions/workflow-controls/background.mjs";
import {
    applyShellToolMapping,
    permissionConfigFile,
    removeShellToolMapping,
} from "../scripts/permission-shell-tools.mjs";

function temporary() {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-background-")));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

const open = {
    interactive: true,
    guardInstalled: false,
    guard: { enabled: true },
    permissionInstalled: false,
    running: 0,
};

test("background jobs start only where every gate is known to hold", () => {
    assert.deepEqual(admission(open), { ok: true });
    for (const [label, overrides] of [
        ["headless", { interactive: false }],
        ["unknown commands", { commandsKnown: false }],
        ["guard installed, state default on", { guardInstalled: true, guard: { enabled: true } }],
        ["guard installed, state unknown", { guardInstalled: true, guard: undefined }],
        ["permission system without mapping", { permissionInstalled: true }],
        ["permission system mapping elsewhere", { permissionInstalled: true, mapping: { commandArgument: "label" } }],
        ["permission config unreadable", { permissionInstalled: true, mappingError: "bad JSON" }],
        ["too many jobs", { running: MAX_RUNNING_JOBS }],
    ]) {
        const verdict = admission({ ...open, ...overrides });
        assert.equal(verdict.ok, false, label);
        assert.ok(verdict.reason.length > 20, label);
    }

    assert.equal(admission({ ...open, guardInstalled: true, guard: { enabled: false } }).ok, true);
    assert.equal(admission({ ...open, permissionInstalled: true, mapping: { commandArgument: "command" } }).ok, true);
    assert.equal(mappingGatesCommand({ commandArgument: "command", workdirArgument: "cwd" }), true);
    assert.equal(mappingGatesCommand({ commandArgument: "command", workdirArgument: 3 }), false);
});

test("the guard resolves as the guard does: default on, global, then a trusted project", () => {
    const home = temporary();
    const cwd = temporary();
    try {
        assert.deepEqual(guardEnabled({ home, cwd }), { enabled: true, source: "default" });
        writeJson(path.join(home, ".pi", "jev-guard.json"), { enabled: false });
        assert.deepEqual(guardEnabled({ home, cwd }), { enabled: false, source: "global" });
        writeJson(path.join(cwd, ".pi", "jev-guard.json"), { enabled: true });
        assert.equal(guardEnabled({ home, cwd, trusted: false }).enabled, false, "untrusted project ignored");
        assert.deepEqual(guardEnabled({ home, cwd, trusted: true }), { enabled: true, source: "project" });
        // A corrupt file is read as absent, as the guard reads it, and so is one with comments: the
        // guard parses strictly, so a commented "off" is on to it and must be on here too.
        writeJson(path.join(home, ".pi", "jev-guard.json"), "{ not json");
        assert.equal(guardEnabled({ home, cwd }).enabled, true);
        writeJson(path.join(home, ".pi", "jev-guard.json"), '{ // off\n "enabled": false }');
        assert.equal(guardEnabled({ home, cwd }).enabled, true);
        // A byte-order mark is stripped, as the guard strips it.
        writeJson(path.join(home, ".pi", "jev-guard.json"), '\uFEFF{ "enabled": false }');
        assert.equal(guardEnabled({ home, cwd }).enabled, false);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test("permission config is read with comments, and a trusted project's entry wins", () => {
    const agentDir = temporary();
    const cwd = temporary();
    try {
        const global = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
        const project = path.join(cwd, ".pi", "extensions", "pi-permission-system", "config.json");
        assert.equal(effectiveShellMapping({ agentDir, cwd }), undefined);
        writeJson(
            global,
            '{\n  // a comment\n  "note": "// not a comment", /* block */\n  "shellTools": { "background": { "commandArgument": "command" } }\n}',
        );
        assert.equal(readJsonc(global).note, "// not a comment");
        assert.deepEqual(effectiveShellMapping({ agentDir, cwd }), { commandArgument: "command" });
        writeJson(project, { shellTools: { background: { commandArgument: "label" } } });
        assert.deepEqual(effectiveShellMapping({ agentDir, cwd, trusted: false }), { commandArgument: "command" });
        assert.deepEqual(effectiveShellMapping({ agentDir, cwd, trusted: true }), { commandArgument: "label" });
        writeJson(global, "{ broken");
        assert.throws(() => effectiveShellMapping({ agentDir, cwd }));
    } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test("jobs report once, cap their log, keep a tail, and go quiet after the session closes", async () => {
    const logDir = path.join(temporary(), "logs");
    const reports = [];
    const pending = [];
    const manager = createJobManager({
        logDir,
        report: (job) => reports.push({ ...job }),
        run: (command, _cwd, { onData, signal }) =>
            new Promise((resolve, reject) => {
                pending.push({ command, onData, resolve });
                signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
    });
    try {
        const job = manager.start({ command: "run-eval --all", cwd: logDir, label: "eval" });
        await new Promise((resolve) => setImmediate(resolve));
        const big = Buffer.alloc(MAX_LOG_BYTES + 1024, "a");
        pending[0].onData(big);
        pending[0].onData(Buffer.from("\nline one\u001b[31m\nfinal line\n"));
        pending[0].resolve({ exitCode: 3 });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reports.length, 1);
        assert.equal(reports[0].state, "exited");
        assert.equal(reports[0].exitCode, 3);
        assert.equal(reports[0].truncated, true);
        assert.ok(fs.statSync(job.logPath).size < MAX_LOG_BYTES + 200, "the log is capped");
        const text = completionText(reports[0]);
        assert.match(text, /Background job 1 \(eval\) finished with exit code 3/u);
        assert.match(text, /final line/u);
        assert.doesNotMatch(text, /\u001b/u, "control characters are stripped");
        assert.match(listText(manager.list()), /exit 3/u);

        manager.start({ command: "sleep 100", cwd: logDir });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(manager.running(), 1);
        assert.equal(manager.stop("2"), true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reports.at(-1).state, "stopped");
        assert.equal(reports.at(-1).stoppedBy, "user");
        assert.equal(manager.stop("2"), false, "a finished job cannot be stopped twice");

        manager.start({ command: "sleep 100", cwd: logDir });
        await new Promise((resolve) => setImmediate(resolve));
        const before = reports.length;
        manager.close();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reports.length, before, "nothing is reported into an ended session");
        assert.equal(fs.existsSync(logDir), false, "logs are deleted with the session");
        assert.throws(() => manager.start({ command: "echo late", cwd: logDir }), /ended/u);
    } finally {
        fs.rmSync(path.dirname(logDir), { recursive: true, force: true });
    }
});

test("tails keep the last lines within bounds", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\r\n");
    const tail = tailOf(text);
    assert.equal(tail.split("\n").length, 40);
    assert.ok(tail.endsWith("line 99"));
    assert.ok(tailOf("x".repeat(10000)).length <= 4000);
});

test("stale session logs are pruned, current ones and foreign names are kept", () => {
    const root = temporary();
    try {
        const stale = path.join(root, "123-abcdef01");
        const fresh = path.join(root, "456-abcdef02");
        const foreign = path.join(root, "keep-me");
        for (const dir of [stale, fresh, foreign]) {
            fs.mkdirSync(dir);
        }

        const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        fs.utimesSync(stale, old, old);
        fs.utimesSync(foreign, old, old);
        assert.equal(pruneStaleLogs({ root }), 1);
        assert.equal(fs.existsSync(stale), false);
        assert.equal(fs.existsSync(fresh), true);
        assert.equal(fs.existsSync(foreign), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("the installer seam merges one shellTools entry and removes only its own", () => {
    const agentDir = temporary();
    try {
        const file = permissionConfigFile(agentDir);
        assert.deepEqual(applyShellToolMapping(agentDir), { applied: false, reason: "not-installed" });

        const manifest = path.join(
            agentDir,
            "npm",
            "node_modules",
            "@gotgenes",
            "pi-permission-system",
            "package.json",
        );
        writeJson(manifest, { name: "@gotgenes/pi-permission-system" });
        assert.equal(applyShellToolMapping(agentDir).reason, "created");
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
            shellTools: { background: { commandArgument: "command" } },
        });
        assert.equal(applyShellToolMapping(agentDir).reason, "already-current");
        assert.deepEqual(removeShellToolMapping(agentDir), { removed: true, deletedFile: true });
        assert.equal(fs.existsSync(file), false, "a file that only held SpecPi's entry is removed");

        // Existing configuration survives, and a remapped entry is replaced and reported.
        writeJson(file, {
            yoloMode: false,
            permission: { bash: { "rm *": "deny" } },
            shellTools: { exec_command: { commandArgument: "cmd" }, background: { commandArgument: "label" } },
        });
        const replaced = applyShellToolMapping(agentDir);
        assert.equal(replaced.applied, true);
        assert.equal(replaced.replaced, true);
        const merged = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.deepEqual(merged.permission, { bash: { "rm *": "deny" } });
        assert.deepEqual(merged.shellTools.exec_command, { commandArgument: "cmd" });
        assert.deepEqual(merged.shellTools.background, { commandArgument: "command" });
        assert.deepEqual(removeShellToolMapping(agentDir), { removed: true, deletedFile: false });
        const after = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.deepEqual(after.shellTools, { exec_command: { commandArgument: "cmd" } });
        assert.equal(after.yoloMode, false);

        // A file with comments is never rewritten, and removal leaves a user's own entry alone.
        const commented =
            '{ // mine\n "shellTools": { "background": { "commandArgument": "command", "workdirArgument": "cwd" } } }';
        writeJson(file, commented);
        assert.equal(applyShellToolMapping(agentDir).reason, "unreadable");
        assert.equal(fs.readFileSync(file, "utf8"), commented);
        writeJson(file, { shellTools: { background: { commandArgument: "command", workdirArgument: "cwd" } } });
        assert.deepEqual(removeShellToolMapping(agentDir), { removed: false });
    } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
    }
});

test("bash calls that would hold the conversation are recognised, ordinary ones are not", async () => {
    const { blockingShellCall, blockingShellReason } = await import("../extensions/workflow-controls/background.mjs");
    for (const input of [
        { command: "for i in $(seq 1 20); do gh pr checks 85; sleep 30; done" },
        { command: "while ! curl -s localhost:8080; do sleep 15; done" },
        { command: "sleep 90 && gh run list" },
        { command: "sleep 2m" },
        { command: "gh run watch 123 --exit-status" },
        { command: "gh pr checks 85 --watch" },
        { command: "tail -f server.log" },
        { command: "npm run check", timeout: 1200 },
    ]) {
        assert.ok(blockingShellCall(input), JSON.stringify(input));
    }

    for (const input of [
        { command: "npm test" },
        { command: "npm run check", timeout: 300 },
        { command: "sleep 5 && curl localhost" },
        { command: "for f in *.json; do jq . $f; done" },
        { command: "for i in 1 2 3; do echo $i; sleep 2; done" },
        { command: "git log --oneline -5" },
        {},
    ]) {
        assert.equal(blockingShellCall(input), undefined, JSON.stringify(input));
    }

    assert.match(blockingShellReason("it sleeps"), /background tool/u);
});

test("Chat's job list carries what /jobs shows, running first, and nothing from the log", () => {
    const { decodeBackgroundJobs } = createRequire(import.meta.url)("../vscode/src/background-jobs.js");
    const job = (id, state, extra = {}) => ({
        id: String(id),
        label: `job ${id}`,
        command: `run ${id}`,
        cwd: "/secret/project",
        logPath: "/secret/log",
        tail: "private output",
        state,
        exitCode: state === "exited" ? 0 : undefined,
        startedAt: 1_000 * id,
        endedAt: state === "running" ? undefined : 1_000 * id + 500,
        ...extra,
    });
    const jobs = [
        ...Array.from({ length: 9 }, (_, index) => job(index + 1, "exited")),
        job(10, "running"),
        job(11, "stopped", { label: undefined }),
    ];
    const line = widgetPayload(jobs);
    assert.doesNotMatch(line, /secret|private output/u);
    const decoded = decodeBackgroundJobs([line]);
    assert.deepEqual(
        decoded.jobs.map((item) => item.id),
        ["10", "11", "9", "8", "7", "6", "5", "4"],
    );
    assert.deepEqual(decoded.jobs[0], {
        id: "10",
        label: "job 10",
        command: "run 10",
        state: "running",
        exitCode: null,
        startedAt: 10_000,
        endedAt: null,
    });
    assert.equal(decoded.jobs[1].label, "");
    assert.equal(decoded.jobs[2].exitCode, 0);
});

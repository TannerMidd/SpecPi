import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveLaunch } from "../vscode/src/launch.js";
import { RpcClient } from "../vscode/src/rpc-client.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piShim = path.join(repository, "node_modules/.bin", process.platform === "win32" ? "pi.cmd" : "pi");
const extensionDirectory = path.join(repository, "extensions");
const extensionArguments = fs.readdirSync(extensionDirectory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(extensionDirectory, entry.name, ...(entry.isDirectory() ? ["index.ts"] : []));

    return candidate.endsWith(".ts") && fs.existsSync(candidate) ? ["-e", candidate] : [];
});

function isolatedEnvironment(root) {
    const environment = {};
    const allowed = new Set(["path", "pathext", "systemroot", "windir", "comspec"]);
    for (const [name, value] of Object.entries(process.env)) {
        if (allowed.has(name.toLowerCase())) {
            environment[name] = value;
        }
    }

    Object.assign(environment, {
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_OFFLINE: "1",
        HOME: root,
        USERPROFILE: root,
        TEMP: root,
        TMP: root,
        APPDATA: path.join(root, "AppData/Roaming"),
        LOCALAPPDATA: path.join(root, "AppData/Local"),
        XDG_CONFIG_HOME: path.join(root, ".config"),
        XDG_DATA_HOME: path.join(root, ".local/share"),
    });
    if (process.platform === "win32") {
        environment.HOMEDRIVE = path.parse(root).root.slice(0, 2);
        environment.HOMEPATH = root.slice(2);
    }

    for (const name of ["PI_CODING_AGENT_DIR", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
        fs.mkdirSync(environment[name], { recursive: true });
    }

    return environment;
}

function connect(child) {
    const events = [];
    const waiting = new Set();
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let sequence = 0;
    let failure;
    let stderr = "";

    const fail = (error) => {
        failure = error;
        for (const waiter of waiting) {
            waiter.reject(error);
        }
    };

    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", (code) => {
        fail(new Error(`Pi exited (${code}). ${stderr}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-32000);
    });
    child.stdout.on("data", (chunk) => {
        buffer += decoder.write(chunk);
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/u, "");
            buffer = buffer.slice(newline + 1);
            if (!line) {
                continue;
            }

            let event;
            try {
                event = JSON.parse(line);
            } catch {
                fail(new Error(`Invalid RPC JSONL: ${line}`));

                return;
            }

            events.push(event);
            for (const waiter of [...waiting]) {
                waiter.accept(event, events.length - 1);
            }
        }
    });

    const wait = (predicate, since = 0) => {
        const existing = events.slice(since).find(predicate);
        if (existing) {
            return Promise.resolve(existing);
        }

        if (failure) {
            return Promise.reject(failure);
        }

        return new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                clearTimeout(timer);
                waiting.delete(waiter);
                callback(value);
            };

            const waiter = {
                accept(event, index) {
                    if (index >= since && predicate(event)) {
                        finish(resolve, event);
                    }
                },
                reject(error) {
                    finish(reject, error);
                },
            };
            const timer = setTimeout(() => {
                finish(reject, new Error(`RPC response timed out. ${stderr}`));
            }, 20000);
            waiting.add(waiter);
        });
    };

    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const request = async (type, fields = {}) => {
        const id = `test-${++sequence}`;
        const response = wait((event) => event.type === "response" && event.id === id);
        send({ id, type, ...fields });
        const result = await response;
        assert.equal(result.success, true, result.error);

        return result.data;
    };

    return { events, request, send, wait };
}

test(
    "real isolated Pi RPC starts all SpecPi extensions and preserves guarded, visible command workflows",
    { timeout: 60000 },
    async () => {
        assert.ok(
            fs.existsSync(piShim),
            "Install repository development dependencies before running RPC integration tests",
        );
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-vscode-rpc-"));
        const cwd = path.join(root, "workspace");
        fs.mkdirSync(cwd);
        fs.writeFileSync(path.join(cwd, "example.txt"), "Synthetic source\n");
        const env = isolatedEnvironment(root);
        const launch = await resolveLaunch({ piPath: piShim, nodePath: process.execPath, env });
        assert.match(launch.args[0], /dist[/\\]bundle[/\\]cli\.js$/u);
        const child = spawn(
            launch.command,
            [
                ...launch.args,
                "--mode",
                "rpc",
                "--offline",
                "--no-session",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "-e",
                path.join(repository, "tests/fixtures/vscode-pi-harness.ts"),
                ...extensionArguments,
                "--provider",
                "specpi-rpc-fixture",
                "--model",
                "offline-fixture",
            ],
            { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        const closed = once(child, "close");
        const rpc = connect(child);

        async function notification(command, pattern) {
            const cursor = rpc.events.length;
            await rpc.request("prompt", { message: command });
            const event = await rpc.wait((item) => item.method === "notify" && pattern.test(item.message), cursor);

            return event.message;
        }

        async function editCommand(command, title, value) {
            const cursor = rpc.events.length;
            const pending = rpc.request("prompt", { message: command });
            const editor = await rpc.wait((item) => item.method === "editor" && item.title === title, cursor);
            rpc.send({
                type: "extension_ui_response",
                id: editor.id,
                ...(value === undefined ? { cancelled: true } : { value }),
            });
            await pending;

            return editor;
        }

        try {
            const initial = await rpc.request("get_state");
            assert.equal(initial.model.provider, "specpi-rpc-fixture");
            assert.equal(initial.sessionFile, undefined);
            assert.equal(
                rpc.events.some((event) => event.method === "select" && event.title === "SpecPi command guard"),
                false,
            );
            assert.equal(
                rpc.events.some((event) => event.type === "extension_error"),
                false,
            );
            await notification("/guard status", /^Mode: guard;/u);
            for (const suffix of ["", " clear"]) {
                const cursor = rpc.events.length;
                await notification(`/rpc-usage-probe${suffix}`, /^Synthetic provider usage report/u);
                const statuses = rpc.events.slice(cursor).filter((event) => event.method === "setStatus");
                assert.deepEqual(
                    statuses.map((event) => event.statusKey),
                    ["aa-codex-usage", "provider-usage"],
                );
                assert.deepEqual(
                    statuses.map((event) => event.statusText),
                    suffix ? [undefined, undefined] : ["\u001b[36mcodex\u001b[0m ▀▀▀▄▄ 4d", "claude 25% 5h 40% 7d"],
                );
            }

            const { commands } = await rpc.request("get_commands");
            for (const name of [
                "guard",
                "task",
                "scope",
                "experiment",
                "challenge",
                "spec",
                "files",
                "wishlist",
                "harness-improvement",
                "delegate",
            ]) {
                assert.ok(
                    commands.some((command) => command.name === name),
                    `Missing loaded SpecPi command: ${name}`,
                );
            }

            await rpc.request("prompt", { message: "/guard strict" });
            await notification("/guard status", /^Mode: strict;/u);
            for (const confirmed of [false, true]) {
                const cursor = rpc.events.length;
                const pending = rpc.request("prompt", { message: "/guard guard" });
                const dialog = await rpc.wait(
                    (event) => event.method === "confirm" && event.title === "Switch to Guard mode?",
                    cursor,
                );
                rpc.send({ type: "extension_ui_response", id: dialog.id, confirmed });
                await pending;
                await notification("/guard status", confirmed ? /^Mode: guard;/u : /^Mode: strict;/u);
            }

            const challenge = await editCommand("/challenge status", "Completion challenge (view only)");
            assert.match(challenge.prefill, /Synthetic review evidence/u);
            const task =
                "Objective: Verify RPC commands\nHypothesis: RPC editors preserve explicit choices\nRequirements:\n- R1: Show the handoff\n  Acceptance: The editor contains the objective\nPaths:\n- example.txt\nRollback: Clear the task contract\nNon-goals:\n- Model requests";
            await editCommand("/task set", "Task contract", task);
            const handoff = await editCommand("/task handoff", "Task handoff (view only)");
            assert.match(handoff.prefill, /Verify RPC commands/u);
            const wishlist = await editCommand("/wishlist", "SpecPi Wishlist (view only; changes are ignored)");
            assert.match(wishlist.prefill, /Wishlist|Capability/u);
            await notification("/spec on", /controls the interactive terminal interface/u);
            await notification("/files", /interactive TUI mode/u);

            const cursor = rpc.events.length;
            const dialogProbe = rpc.request("prompt", { message: "/rpc-dialog-probe" });
            for (const [method, value] of [
                ["select", "Second"],
                ["input", "Unicode\u2028separator\u2029text"],
                ["editor", "Two\nlines"],
            ]) {
                const dialog = await rpc.wait(
                    (event) => event.method === method && event.title.startsWith("RPC "),
                    cursor,
                );
                rpc.send({ type: "extension_ui_response", id: dialog.id, value });
            }

            await dialogProbe;
            const result = await rpc.wait(
                (event) => event.method === "notify" && event.message.includes('"selected":"Second"'),
                cursor,
            );
            assert.deepEqual(JSON.parse(result.message), {
                selected: "Second",
                input: "Unicode\u2028separator\u2029text",
                edited: "Two\nlines",
            });

            const reset = await rpc.request("new_session");
            assert.equal(reset.cancelled, false);
            const afterReset = await rpc.request("get_state");
            assert.notEqual(afterReset.sessionId, initial.sessionId);
            assert.equal(afterReset.sessionFile, undefined);
            await notification("/guard status", /^Mode: guard;/u);
            assert.equal(
                rpc.events.some((event) => event.type === "agent_start"),
                false,
                "Command-only smoke tests must never dispatch inference",
            );
            assert.equal(
                rpc.events.some((event) => event.type === "extension_error"),
                false,
            );
            assert.equal(
                fs.existsSync(path.join(root, "agent", "sessions")),
                false,
                "--no-session must not create transcript storage",
            );
        } finally {
            child.stdin.end();
            const terminate = setTimeout(() => child.kill(), 3000);
            try {
                await closed;
            } finally {
                clearTimeout(terminate);
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    },
);

test(
    "real bundled Pi startup waits through legacy Guard fallback before normal RPC deadlines",
    { timeout: 15000 },
    async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-vscode-legacy-startup-"));
        const cwd = path.join(root, "workspace");
        fs.mkdirSync(cwd);
        const env = isolatedEnvironment(root);
        const launch = await resolveLaunch({ piPath: piShim, nodePath: process.execPath, env });
        const client = new RpcClient({
            ...launch,
            args: [
                ...launch.args,
                "--mode",
                "rpc",
                "--offline",
                "--no-session",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "-e",
                path.join(repository, "tests/fixtures/vscode-pi-legacy-startup.ts"),
            ],
            cwd,
            env,
            requestTimeout: 200,
        });
        const events = [];
        client.on("event", (event) => {
            events.push(event);
            if (event.type === "extension_ui_request" && event.method === "select") {
                client.send({
                    type: "extension_ui_response",
                    id: event.id,
                    ...(event.title === "SpecPi command guard" ? { cancelled: true } : { value: "Strict" }),
                });
            }
        });
        try {
            await client.start();
            await client.waitUntilReady({ timeoutMs: 10000 });
            const initial = await client.request("get_state", {}, { timeoutMs: 5000 });
            assert.equal(initial.isStreaming, false);
            assert.equal(initial.sessionFile, undefined);
            assert.ok(events.some((event) => event.title === "SpecPi command guard"));
            assert.ok(
                events.some(
                    (event) =>
                        event.method === "notify" &&
                        event.message === "Legacy startup defaulted to Guard before reading UI responses.",
                ),
                "Pi must reach the legacy fallback despite an immediately cancelled startup selector",
            );
            await client.request("prompt", { message: "/legacy-startup-probe" }, { timeoutMs: 5000 });
            assert.ok(
                events.some((event) => event.method === "notify" && event.message === "Post-startup mode: Strict"),
                "UI choices must work once Pi has installed its stdin reader",
            );
            assert.equal(
                events.some((event) => event.type === "agent_start" || event.type === "extension_error"),
                false,
            );
            assert.equal(fs.existsSync(path.join(root, "agent", "sessions")), false);
        } finally {
            await client.stop();
            const resolvedRoot = path.resolve(root);
            assert.ok(
                path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) &&
                    path.basename(resolvedRoot).startsWith("specpi-vscode-legacy-startup-"),
            );
            fs.rmSync(resolvedRoot, { recursive: true, force: true });
        }
    },
);

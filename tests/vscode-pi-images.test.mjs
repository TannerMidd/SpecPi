import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveLaunch } from "../vscode/src/launch.js";
import { RpcClient } from "../vscode/src/rpc-client.js";
import { createState, applyEvent, replaceMessages } from "../vscode/src/chat-state.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCommand =
    process.env.SPECPI_TEST_PI ??
    path.join(repository, "node_modules/.bin", process.platform === "win32" ? "pi.cmd" : "pi");
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFElEQVR4AWKSi5r2H4SZGKAAzgAAAAD//+cbP58AAAAGSURBVAMAWfEEIZxk5/sAAAAASUVORK5CYII=";
const IMAGE = { type: "image", data: PNG, mimeType: "image/png" };

async function isolatedEnvironment(root) {
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
        await fs.mkdir(environment[name], { recursive: true });
    }

    return environment;
}

function eventLog(client) {
    const events = [];
    const waiting = new Set();
    client.on("event", (event) => {
        events.push(event);
        for (const waiter of waiting) {
            waiter.accept();
        }
    });

    function wait(predicate, since) {
        return new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                clearTimeout(timer);
                waiting.delete(waiter);
                client.off("exit", onExit);
                callback(value);
            };

            const onExit = () =>
                finish(reject, new Error("Isolated image-fixture Pi exited before completing its run."));
            const waiter = {
                accept() {
                    const event = events.slice(since).find(predicate);
                    if (event) {
                        finish(resolve, event);
                    }
                },
            };
            const timer = setTimeout(
                () => finish(reject, new Error("The isolated image-fixture Pi did not finish in time.")),
                15_000,
            );
            client.once("exit", onExit);
            waiting.add(waiter);
            waiter.accept();
        });
    }

    async function prompt(message, images = []) {
        const cursor = events.length;
        await client.request("prompt", { message, images });
        await wait((event) => event.type === "agent_settled", cursor);

        return events.slice(cursor);
    }

    return { events, prompt };
}

function assistantReport(messages) {
    const assistant = messages.findLast((message) => message.role === "assistant");
    assert.equal(assistant.stopReason, "stop");

    return JSON.parse(
        assistant.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
    );
}

function assertImage(messages, role = "user") {
    const message = messages.findLast(
        (item) => item.role === role && item.content.some((part) => part.type === "image"),
    );
    assert.ok(message, `Expected an image in a ${role} message`);
    assert.deepEqual(
        message.content.filter((part) => part.type === "image"),
        [IMAGE],
    );

    return message;
}

function imageRpcArguments(launch, sessions) {
    return [
        ...launch.args,
        "--mode",
        "rpc",
        "--offline",
        "--session-dir",
        sessions,
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "-e",
        path.join(repository, "tests/fixtures/vscode-pi-image-provider.ts"),
        "--provider",
        "specpi-image-fixture",
        "--model",
        "offline-vision",
    ];
}

test(
    "real isolated Pi accepts image-only prompts, persists vision context, clones and forks image turns",
    { timeout: 60_000 },
    async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-vscode-image-rpc-"));
        const cwd = path.join(root, "workspace");
        const sessions = path.join(root, "chat-owned");
        await fs.mkdir(cwd);
        await fs.mkdir(sessions);
        const env = await isolatedEnvironment(root);
        const launch = await resolveLaunch({ piPath: piCommand, nodePath: process.execPath, env });
        const args = imageRpcArguments(launch, sessions);
        const clients = [];
        async function connect(sessionFile) {
            const client = new RpcClient({
                command: launch.command,
                args: [...args, ...(sessionFile ? ["--session", sessionFile] : [])],
                cwd,
                env,
            });
            clients.push(client);
            const log = eventLog(client);
            await client.start();
            await client.waitUntilReady({ timeoutMs: 30_000 });

            return { client, log };
        }

        try {
            const { client, log } = await connect();
            const { models } = await client.request("get_available_models");
            assert.deepEqual(
                models.find((model) => model.provider === "specpi-image-fixture" && model.id === "offline-vision")
                    .input,
                ["text", "image"],
            );
            const run = await log.prompt("", [IMAGE]);
            const { messages } = await client.request("get_messages");
            assertImage(messages);
            assert.deepEqual(assistantReport(messages), {
                fixture: true,
                text: "",
                received: [IMAGE],
                toolReceived: [],
            });
            assert.ok(run.some((event) => event.type === "message_start" && event.message.role === "user"));
            const original = await client.request("get_state");
            assert.equal(original.isStreaming, false);
            assert.ok(original.sessionFile);
            assert.equal(path.dirname(path.resolve(original.sessionFile)), path.resolve(sessions));
            const { entries } = await client.request("get_entries");
            const userEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
            assert.deepEqual(
                userEntry.message.content.filter((part) => part.type === "image"),
                [IMAGE],
            );

            assert.equal((await client.request("clone")).cancelled, false);
            const cloned = await client.request("get_state");
            assert.notEqual(cloned.sessionId, original.sessionId);
            assertImage((await client.request("get_messages")).messages);
            const forked = await client.request("fork", { entryId: userEntry.id });
            assert.deepEqual(forked, { text: "", cancelled: false });
            assert.equal(
                (await client.request("get_messages")).messages.some((message) => message.role === "user"),
                false,
            );

            await log.prompt("", [IMAGE]);
            assert.deepEqual(assistantReport((await client.request("get_messages")).messages).received, [IMAGE]);
            const toolRun = await log.prompt("return a tool image");
            const toolEnd = toolRun.find(
                (event) => event.type === "tool_execution_end" && event.toolName === "fixture_image",
            );
            assert.ok(toolEnd);
            assert.deepEqual(toolEnd.result.content, [IMAGE]);
            const projected = createState();
            for (const event of toolRun) {
                applyEvent(projected, event);
            }

            assert.equal(projected.messages.find((message) => message.role === "tool").images[0].data, PNG);
            const afterTool = (await client.request("get_messages")).messages;
            assertImage(afterTool, "toolResult");
            assert.deepEqual(assistantReport(afterTool).toolReceived, [IMAGE]);
            const restoredProjection = createState();
            replaceMessages(restoredProjection, afterTool);
            assert.equal(restoredProjection.messages.find((message) => message.role === "tool").images[0].data, PNG);
            const saved = await client.request("get_state");
            await client.stop();

            const reconnected = await connect(saved.sessionFile);
            const restored = (await reconnected.client.request("get_messages")).messages;
            assertImage(restored);
            assertImage(restored, "toolResult");
            assert.deepEqual(assistantReport(restored).toolReceived, [IMAGE]);
            assert.equal(
                (await reconnected.client.request("switch_session", { sessionPath: original.sessionFile })).cancelled,
                false,
            );
            const originalMessages = (await reconnected.client.request("get_messages")).messages;
            assert.deepEqual(assistantReport(originalMessages), {
                fixture: true,
                text: "",
                received: [IMAGE],
                toolReceived: [],
            });
            for (const candidate of clients) {
                assert.equal(candidate.state, candidate === reconnected.client ? "running" : "stopped");
            }

            assert.equal(
                log.events.some((event) => event.type === "extension_error"),
                false,
            );
            assert.equal(
                reconnected.log.events.some((event) => event.type === "extension_error"),
                false,
            );
        } finally {
            for (const client of clients) {
                await client.stop();
            }

            const resolvedRoot = path.resolve(root);
            assert.ok(
                path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) &&
                    path.basename(resolvedRoot).startsWith("specpi-vscode-image-rpc-"),
            );
            await fs.rm(resolvedRoot, { recursive: true, force: true });
        }
    },
);

test(
    "real isolated Pi forks before runtime startup and preserves an independently connected source conversation",
    { timeout: 90_000 },
    async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-vscode-image-rpc-"));
        const clients = [];
        t.after(async () => {
            for (const client of clients) {
                await client.stop();
            }

            const resolvedRoot = path.resolve(root);
            assert.ok(
                path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) &&
                    path.basename(resolvedRoot).startsWith("specpi-vscode-image-rpc-"),
            );
            await fs.rm(resolvedRoot, { recursive: true, force: true });
        });
        const cwd = path.join(root, "workspace");
        const sessions = path.join(root, "chat-owned");
        const startupExtension = path.join(root, "startup-marker.mjs");
        await fs.mkdir(cwd);
        await fs.mkdir(sessions);
        await fs.writeFile(
            startupExtension,
            [
                "export default function startupMarker(pi) {",
                "    pi.on('session_start', (_event, context) => {",
                "        pi.appendEntry('specpi-startup-marker', { sessionId: context.sessionManager.getSessionId() });",
                "    });",
                "}",
                "",
            ].join("\n"),
        );
        const env = await isolatedEnvironment(root);
        const launch = await resolveLaunch({ piPath: piCommand, nodePath: process.execPath, env });
        const args = [...imageRpcArguments(launch, sessions), "-e", startupExtension];
        async function connect(forkSource) {
            const client = new RpcClient({
                command: launch.command,
                args: [...args, ...(forkSource ? ["--fork", forkSource] : [])],
                cwd,
                env,
            });
            clients.push(client);
            const log = eventLog(client);
            await client.start();
            await client.waitUntilReady({ timeoutMs: 30_000 });

            return { client, log };
        }

        const source = await connect();
        await source.log.prompt("Original conversation", [IMAGE]);
        const original = await source.client.request("get_state");
        const originalEntries = await source.client.request("get_entries");
        const originalMessages = await source.client.request("get_messages");
        const originalBytes = await fs.readFile(original.sessionFile);
        const originalPid = source.client.child.pid;
        const sourceUser = originalEntries.entries.find(
            (entry) => entry.type === "message" && entry.message.role === "user",
        );
        assert.ok(sourceUser);

        async function assertSourceUnchanged() {
            const state = await source.client.request("get_state");
            assert.equal(state.sessionId, original.sessionId);
            assert.equal(state.sessionFile, original.sessionFile);
            assert.equal(source.client.state, "running");
            assert.equal(source.client.child.pid, originalPid);
            assert.deepEqual(await source.client.request("get_entries"), originalEntries);
            assert.deepEqual(await source.client.request("get_messages"), originalMessages);
            assert.deepEqual(await fs.readFile(original.sessionFile), originalBytes);
        }

        const target = await connect(original.sessionFile);
        const copied = await target.client.request("get_state");
        assert.notEqual(target.client.child.pid, originalPid);
        assert.notEqual(copied.sessionId, original.sessionId);
        assert.notEqual(copied.sessionFile, original.sessionFile);
        assert.equal(path.dirname(path.resolve(copied.sessionFile)), path.resolve(sessions));
        const copiedEntries = await target.client.request("get_entries");
        assert.ok(
            copiedEntries.entries.some(
                (entry) => entry.customType === "specpi-startup-marker" && entry.data?.sessionId === copied.sessionId,
            ),
            "Target startup extension must append to the copied session, before any RPC fork or clone",
        );
        assertImage((await target.client.request("get_messages")).messages);
        await assertSourceUnchanged();

        assert.equal((await target.client.request("clone")).cancelled, false);
        const cloned = await target.client.request("get_state");
        assert.notEqual(cloned.sessionId, copied.sessionId);
        assertImage((await target.client.request("get_messages")).messages);
        await assertSourceUnchanged();

        const forked = await target.client.request("fork", { entryId: sourceUser.id });
        assert.deepEqual(forked, { text: "Original conversation", cancelled: false });
        const edited = await target.client.request("get_state");
        assert.notEqual(edited.sessionId, cloned.sessionId);
        assert.equal(
            (await target.client.request("get_messages")).messages.some((message) => message.role === "user"),
            false,
        );
        await target.log.prompt("Edited conversation", [IMAGE]);
        const targetMessages = await target.client.request("get_messages");
        assert.equal(assistantReport(targetMessages.messages).text, "Edited conversation");
        assertImage(targetMessages.messages);
        await assertSourceUnchanged();

        const targetBytes = await fs.readFile(edited.sessionFile);
        await source.log.prompt("Continue original conversation");
        const continued = await source.client.request("get_state");
        assert.equal(continued.sessionId, original.sessionId);
        assert.equal(source.client.child.pid, originalPid);
        assert.equal(
            assistantReport((await source.client.request("get_messages")).messages).text,
            "Continue original conversation",
        );
        assert.equal(target.client.state, "running");
        assert.equal((await target.client.request("get_state")).sessionId, edited.sessionId);
        assert.deepEqual(await target.client.request("get_messages"), targetMessages);
        assert.deepEqual(await fs.readFile(edited.sessionFile), targetBytes);
        for (const { log } of [source, target]) {
            assert.equal(
                log.events.some((event) => event.type === "extension_error"),
                false,
            );
        }
    },
);

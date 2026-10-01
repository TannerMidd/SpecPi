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

async function promptUntilSettled(client, message) {
    const events = [];
    const settled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The isolated codemode Pi did not settle in time.")), 20_000);
        client.on("event", (event) => {
            events.push(event);
            if (event.type === "agent_settled") {
                clearTimeout(timer);
                resolve();
            }
        });
        client.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("The isolated codemode Pi exited before settling."));
        });
    });
    await client.request("prompt", { message });
    await settled;

    return events;
}

test("real isolated Pi codemode runs render as one card, live and after reload", { timeout: 60_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-vscode-codemode-rpc-"));
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "note.txt"), "hello\nworld\n");
    const env = await isolatedEnvironment(root);
    const launch = await resolveLaunch({ piPath: piCommand, nodePath: process.execPath, env });
    const client = new RpcClient({
        command: launch.command,
        args: [
            ...launch.args,
            "--mode",
            "rpc",
            "--offline",
            "--session-dir",
            path.join(root, "sessions"),
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "-e",
            "builtin:codemode",
            "-e",
            path.join(repository, "tests/fixtures/vscode-pi-codemode-provider.ts"),
            "--provider",
            "specpi-codemode-fixture",
            "--model",
            "offline-codemode",
            "--tools",
            "read,bash,edit,write,codemode",
        ],
        cwd,
        env,
    });
    try {
        await client.start();
        await client.waitUntilReady({ timeoutMs: 30_000 });
        const events = await promptUntilSettled(client, "run the script");
        // Pi reports the script's calls as nested events; the fixture blocks the bash call.
        assert.ok(
            events.some(
                (event) =>
                    event.type === "tool_execution_end" &&
                    event.toolName === "bash" &&
                    event.isError === true &&
                    event.parentToolCallId === "fixture-codemode-1",
            ),
        );

        const live = createState();
        for (const event of events) {
            applyEvent(live, event);
        }

        const tools = live.messages.filter((message) => message.role === "tool");
        assert.equal(tools.length, 1, "the script's read and bash calls are not separate cards");
        const [card] = tools;
        assert.equal(card.toolName, "codemode");
        assert.match(card.input, /^const source = await tools\.read\(\{ path: "note\.txt" \}\);/u);
        assert.deepEqual(
            card.calls.map(({ name, status, error }) => ({ name, status, error })),
            [
                { name: "read", status: "ok", error: undefined },
                { name: "bash", status: "error", error: "fixture blocks bash" },
            ],
        );
        assert.equal(card.text, 'note says hello\nworld\nbash refused: fixture blocks bash\n{"lines":3}');
        assert.ok(Number.isFinite(card.wallSeconds));

        const { messages } = await client.request("get_messages");
        const reloaded = replaceMessages(createState(), messages).messages.filter((message) => message.role === "tool");
        assert.equal(reloaded.length, 1);
        for (const key of ["toolName", "input", "calls", "text", "wallSeconds", "isError"]) {
            assert.deepEqual(reloaded[0][key], card[key], key);
        }
    } finally {
        await client.stop();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

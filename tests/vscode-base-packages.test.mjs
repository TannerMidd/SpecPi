import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../vscode/src/rpc-client.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
test(
    "the complete base starts through Chat RPC and upstream permission choices stay explicit",
    {
        skip: process.env.SPECPI_CHAT_BASE_SMOKE !== "1",
        timeout: 120_000,
    },
    async (t) => {
        const agentDir = fs.realpathSync(process.env.PI_CODING_AGENT_DIR);
        const relative = path.relative(fs.realpathSync(os.tmpdir()), agentDir);
        assert.ok(
            path.basename(os.tmpdir()).startsWith("specpi-base-check-") && relative === "agent",
            "Real package smoke requires the base check's isolated TEMP and agent directory",
        );
        const client = new RpcClient({
            command: process.execPath,
            args: [
                path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
                "--mode",
                "rpc",
                "--offline",
                "--no-session",
                "--no-context-files",
                "-e",
                path.join(repository, "vscode/src/subagents-bridge.mjs"),
                "-e",
                path.join(repository, "tests/fixtures/vscode-base-packages.ts"),
            ],
            cwd: path.dirname(agentDir),
            env: process.env,
        });
        const events = [];
        let answer;
        client.on("event", (event) => {
            events.push(event);
            if (
                event.type === "extension_ui_request" &&
                event.method === "select" &&
                event.title.startsWith("Permission Required\nSynthetic Chat")
            ) {
                assert.ok(event.options.includes("No") && event.options.includes("Yes"));
                client.send({
                    type: "extension_ui_response",
                    id: event.id,
                    ...(answer ? { value: answer } : { cancelled: true }),
                });
            }
        });
        // Collect transport failures as assertion evidence, never as an unhandled EventEmitter error.
        const failures = [];
        let diagnostics = "";
        client.on("error", (error) => failures.push(error.message));
        try {
            await client.start();
            // Only this synthetic, credential-free fixture may expose bounded child diagnostics.
            client.child.stderr.on("data", (chunk) => {
                diagnostics = (diagnostics + chunk.toString()).slice(-8_000);
            });
            await client.waitUntilReady();
            const { commands } = await client.request("get_commands");
            for (const name of ["scope", "wishlist", "harness-improvement", "usage", "goal", "permission-system"]) {
                assert.ok(
                    commands.some((command) => command.name === name),
                    `Missing /${name}`,
                );
            }

            await client.request("prompt", { message: "/permission-system show" });
            assert.ok(events.some((event) => event.method === "notify" && event.message.includes("yoloMode=")));
            for (const choice of [undefined, "No", "Yes"]) {
                answer = choice;
                await client.request("prompt", { message: "/chat-permission-probe" });
                const report = events.findLast(
                    (event) => event.method === "notify" && event.message.startsWith("CHAT_PERMISSION="),
                );
                assert.ok(report);
                assert.equal(JSON.parse(report.message.slice("CHAT_PERMISSION=".length)).approved, choice === "Yes");
            }

            assert.deepEqual(failures, []);
            assert.equal(
                events.some((event) => event.type === "agent_start" || event.type === "extension_error"),
                false,
            );
        } catch (error) {
            t.diagnostic(diagnostics);
            throw error;
        } finally {
            await client.stop();
        }
    },
);

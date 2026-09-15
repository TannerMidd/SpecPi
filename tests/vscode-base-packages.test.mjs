import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { RpcClient } from "../vscode/src/rpc-client.js";
import { loadPermissionSettings, savePermissionSettings } from "../vscode/src/permission-settings.js";
import permissionConfig from "../vscode/media/permission-config.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
test(
    "the complete base starts through Chat RPC and upstream permission choices stay explicit",
    {
        skip: process.env.SPECPI_CHAT_BASE_SMOKE !== "1",
        timeout: 120_000,
    },
    async (t) => {
        const agentDir = fs.realpathSync.native(process.env.PI_CODING_AGENT_DIR);
        const relative = path.relative(fs.realpathSync.native(os.tmpdir()), agentDir);
        assert.ok(
            path.basename(os.tmpdir()).startsWith("specpi-base-check-") && relative === "agent",
            "Real package smoke requires the base check's isolated TEMP and agent directory",
        );
        // Load the unmodified, pinned installed package only inside the isolated
        // base fixture. Exercise the real loader/merge/normalizer/matcher, not a
        // replacement command evaluator. Commands below are data, never executed.
        const requirePi = createRequire(
            path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        );
        const { createJiti } = requirePi("jiti");
        const alias = Object.fromEntries(
            ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"].map(
                (name) => [name, fileURLToPath(import.meta.resolve(name))],
            ),
        );
        const { PermissionManager } = await createJiti(import.meta.url, { alias }).import(
            path.join(agentDir, "npm/node_modules/@gotgenes/pi-permission-system/src/policy/permission-manager.ts"),
        );
        const rank = { allow: 0, ask: 1, deny: 2 };
        for (const [global, project] of [
            [{}, {}],
            [{ permission: { bash: { "rm *": "deny" } } }, { permission: { bash: { "*": "allow", "rm *": "deny" } } }],
            ...["allow", "ask", "deny"].map((state) => [
                { permission: { bash: { "*": "ask", "git *": "allow" } } },
                { permission: { bash: state } },
            ]),
            [{ permission: { bash: "deny" } }, {}],
            [
                { permission: { "bash*": "ask", "bash**": { "git *": "allow" } } },
                { permission: { bash: { "*": "ask", "rm *": "allow" }, "bash***": "ask" } },
            ],
        ]) {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-policy-"));
            const workspace = path.join(directory, "project");
            const globalAgent = path.join(directory, "agent");
            fs.mkdirSync(workspace);
            const options = { env: { PI_CODING_AGENT_DIR: globalAgent }, home: directory };
            savePermissionSettings(loadPermissionSettings(workspace, "global", options), JSON.stringify(global));
            const original = savePermissionSettings(
                loadPermissionSettings(workspace, "project", options),
                JSON.stringify(project),
            );
            const before = new PermissionManager({ agentDir: globalAgent });
            before.configureForCwd(workspace);
            const commands = [
                "rm",
                "rm file",
                "git reset --hard",
                "git clean",
                "terraform destroy",
                "dd",
                "dropdb",
                "echo safe",
                "git status",
                "python -c pass",
            ];
            const check = (manager, command) =>
                manager.check({ kind: "tool", surface: "bash", input: { command } }).state;
            const previous = commands.map((command) => check(before, command));
            const toolBefore = before.getToolPermission("bash");
            const hiddenBefore = before.isToolFullyDenied("bash");
            const recipe = permissionConfig.appendDestructiveGuard(original.text, JSON.stringify(global));
            savePermissionSettings(original, recipe.text);
            const after = new PermissionManager({ agentDir: globalAgent });
            after.configureForCwd(workspace);
            assert.deepEqual(after.getConfigIssues(), []);
            commands.forEach((command, index) => {
                const state = check(after, command);
                assert.ok(rank[state] >= rank[previous[index]], `Guard weakened ${command}`);
                if (index < 7) {
                    assert.equal(state, "deny", command);
                } else {
                    assert.equal(state, previous[index], `Unrelated command changed: ${command}`);
                }
            });
            assert.equal(after.getToolPermission("bash"), toolBefore);
            assert.equal(after.isToolFullyDenied("bash"), hiddenBefore);
            // Configured shell aliases use this same bash-surface lookup after
            // upstream extraction; custom bash-prefixed surfaces also match.
            for (const surface of ["bash", "bash_custom"]) {
                assert.equal(after.check({ kind: "path-values", surface, values: ["rm file"] }).state, "deny");
            }

            const yolo = new PermissionManager({ agentDir: globalAgent, isYoloEnabled: () => true });
            yolo.configureForCwd(workspace);
            assert.equal(check(yolo, "rm file"), "deny", "An explicit deny must survive YOLO");
        }

        const launch = {
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
        };
        const client = new RpcClient(launch);
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

            // Exercise Chat's writer against real upstream loading, only in the
            // isolated base-check profile. No provider or model prompt is used.
            await client.stop();
            const before = loadPermissionSettings(launch.cwd, "global");
            const saved = savePermissionSettings(
                before,
                JSON.stringify(
                    {
                        yoloMode: true,
                        debugLog: false,
                        permissionReviewLog: false,
                        doublePressToConfirm: false,
                        forwardingTimeoutMs: 5000,
                        promptMaxRows: 30,
                        promptFieldMaxWidth: 500,
                        reviewLogFieldMaxWidth: 1200,
                        permission: {
                            "*": "ask",
                            bash: { "*": "deny", "git status": "allow" },
                            path_write: { "*.env": "deny" },
                        },
                        shellTools: { bg_run: { commandArgument: "command" } },
                        piInfrastructureReadPaths: [],
                        authorizerChain: [],
                    },
                    null,
                    4,
                ),
            );
            if (before.exists && before.text !== saved.text) {
                assert.equal(fs.readFileSync(saved.backup, "utf8"), before.text);
            } else {
                assert.equal(saved.backup, undefined);
            }

            const restarted = new RpcClient(launch);
            const restartedEvents = [];
            restarted.on("event", (event) => restartedEvents.push(event));
            restarted.on("error", (error) => failures.push(error.message));
            try {
                await restarted.start();
                await restarted.waitUntilReady();
                await restarted.request("prompt", { message: "/permission-system show" });
                const summary =
                    restartedEvents.findLast(
                        (event) => event.method === "notify" && event.message.includes("yoloMode="),
                    )?.message || "";
                assert.match(summary, /yoloMode=on/u, "The actual upstream runtime must load the saved YOLO setting");
                assert.ok(summary.includes("bash=deny"), "The saved default shell rule must load");
                assert.ok(summary.includes('bash["git status"]=allow'), "The ordered shell exception must load");
                assert.ok(
                    restartedEvents.some(
                        (event) =>
                            event.method === "setStatus" &&
                            event.statusKey === "pi-permission-system" &&
                            event.statusText === "yolo",
                    ),
                );
                assert.equal(
                    restartedEvents.some((event) => event.type === "agent_start" || event.type === "extension_error"),
                    false,
                );
                assert.deepEqual(failures, []);
            } finally {
                await restarted.stop();
            }
        } catch (error) {
            t.diagnostic(diagnostics);
            throw error;
        } finally {
            await client.stop();
        }
    },
);

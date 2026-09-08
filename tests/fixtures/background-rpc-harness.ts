import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerBackgroundTasks from "../../extensions/background-tasks/index.ts";
import registerCommandGuard from "../../extensions/command-guard/index.ts";
import { TaskRunner, terminateOwned } from "../../extensions/background-tasks/core.mjs";

export default function (pi: ExtensionAPI) {
    const tools = new Map<string, any>();
    let cancelStart: AbortController | undefined;
    let failCleanup = false;
    const runner = new TaskRunner({
        spawnProcess(...args: any[]) {
            const child = spawn(args[0], args[1], args[2]);
            if (cancelStart) {
                const controller = cancelStart;
                queueMicrotask(() => controller.abort());
            }

            return child;
        },
        terminate: (task: any) =>
            failCleanup ? Promise.resolve(false) : terminateOwned(task, { graceMs: 30, observeMs: 3000 }),
    });
    registerCommandGuard(pi);
    registerBackgroundTasks(
        {
            ...pi,
            registerTool(tool: any) {
                tools.set(tool.name, tool);
                pi.registerTool(tool);
            },
        },
        { runner },
    );
    pi.registerCommand("background-fixture", {
        description: "Offline background lifecycle fixture",
        async handler(action, ctx) {
            if (action === "fail-cleanup") {
                failCleanup = true;

                return;
            }

            cancelStart = action === "cancel-start" ? new AbortController() : undefined;
            try {
                const response = await tools.get("background_start").execute(
                    "fixture",
                    {
                        command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`,
                        label: action,
                    },
                    cancelStart?.signal,
                    undefined,
                    ctx,
                );
                const task = JSON.parse(response.content[0].text);
                task.supervisorPid = runner.get(task.id).child.pid;
                ctx.ui.notify(`BACKGROUND_RESULT=${JSON.stringify(task)}`, "info");
            } catch {
                ctx.ui.notify("BACKGROUND_DENIED", "info");
            } finally {
                cancelStart = undefined;
            }
        },
    });
    // Failed-cleanup injection must not leave real fixture processes behind.
    pi.on("session_shutdown", async () => {
        failCleanup = false;
        await runner.shutdown();
    });
}

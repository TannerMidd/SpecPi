import { randomUUID } from "node:crypto";
import { createDelegationController } from "./core.mjs";

const integer = { type: "integer", minimum: 0 };
const string = { type: "string" };
const strings = { type: "array", items: string };
const object = (properties, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
});
const operation = (name, properties = {}, optional = []) =>
    object({ operation: { const: name, type: "string" }, ...properties }, [
        "operation",
        ...Object.keys(properties).filter((key) => !optional.includes(key)),
    ]);
const binding = {
    batchId: string,
    jobId: string,
    attemptId: string,
    packetDigest: string,
    generation: integer,
    resultRevision: integer,
};
export const DELEGATE_SCHEMA = {
    anyOf: [
        operation("run", {
            requestId: string,
            packet: object({
                objective: string,
                requirements: { type: "array", items: object({ id: string, text: string }) },
                decisions: strings,
                nonGoals: strings,
                reason: object({
                    benefit: {
                        type: "string",
                        enum: ["independent_review", "parallel_analysis", "context_isolation"],
                    },
                    why: string,
                    parentWork: {
                        type: "string",
                        description:
                            "Useful independent parent work; required for parallel_analysis, otherwise may be empty.",
                    },
                }),
                jobs: {
                    type: "array",
                    minItems: 1,
                    maxItems: 2,
                    items: object({
                        id: string,
                        mode: { type: "string", enum: ["review", "scout"] },
                        question: string,
                        context: string,
                        sources: strings,
                        requirements: {
                            type: "array",
                            minItems: 1,
                            items: string,
                            description: "Only the requirement IDs assigned to this worker.",
                        },
                    }),
                },
            }),
        }),
        operation("status"),
        operation(
            "collect",
            { batchId: string, afterCursor: integer, waitMs: { type: "integer", minimum: 0, maximum: 30000 } },
            ["afterCursor", "waitMs"],
        ),
        operation("follow_up", { requestId: string, ...binding, prompt: string }),
        operation("resolve", {
            requestId: string,
            ...binding,
            decision: { type: "string", enum: ["accept", "discard", "needs_check"] },
            findings: {
                type: "array",
                items: object({
                    id: string,
                    decision: { type: "string", enum: ["confirmed", "rejected", "needs_check"] },
                }),
            },
        }),
        operation("cancel", { requestId: string, batchId: string, jobId: string }, ["jobId"]),
    ],
};

/** The native entry supplies a preflighted Pi child-session host for the active context. */
export function createDelegationExtension(
    getHost,
    { root = process.cwd(), controllerOptions = {}, prepareContext = () => {} } = {},
) {
    let currentPi;
    let currentContext;
    let toolsReady = false;
    let bindingEpoch = 0;
    let detach = () => {};

    const getGuard = () => {
        let replies = 0;
        let mode;
        currentPi?.events.emit("specpi:guard-state", {
            reply(value) {
                replies += 1;
                mode = value?.mode;
            },
        });

        if (replies === 0) {
            return "absent";
        }

        return replies === 1 ? mode : "ambiguous";
    };

    const controller = createDelegationController({
        ...controllerOptions,
        getHost,
        root,
        getGuard,
        onChange() {
            const state = controller.status();
            syncActiveTool(state.enabled);
            currentContext?.ui?.setStatus?.(
                "specpi-delegation",
                state.enabled
                    ? `Delegate ${state.active}/${state.limits.concurrency} · ${state.sessionCalls}/${state.limits.sessionCalls} calls`
                    : undefined,
            );
        },
    });

    function syncActiveTool(enabled) {
        if (
            !toolsReady ||
            typeof currentPi?.getActiveTools !== "function" ||
            typeof currentPi?.setActiveTools !== "function"
        ) {
            return;
        }

        const active = currentPi.getActiveTools();
        if (active.includes("delegate") !== enabled) {
            currentPi.setActiveTools(enabled ? [...active, "delegate"] : active.filter((name) => name !== "delegate"));
        }
    }

    const factory = (pi) => {
        detach();
        bindingEpoch += 1;
        const issuedEpoch = bindingEpoch;
        const isBound = () => issuedEpoch === bindingEpoch;
        toolsReady = false;
        prepareContext(undefined, true);
        controller.invalidate("runtime factory rebound");
        currentPi = pi;
        currentContext = undefined;
        const subscriptions = [];
        detach = () => {
            for (const off of subscriptions.splice(0)) {
                off();
            }
        };

        const subscribe = (name, handler) => {
            const off = pi.events.on(name, (value) => {
                if (isBound()) {
                    handler(value);
                }
            });
            if (typeof off === "function") {
                subscriptions.push(off);
            }
        };

        subscribe("specpi:delegation-policy", (request) => {
            try {
                request.reply(controller.policyFor(request.input));
            } catch {
                request.reply(undefined);
            }
        });
        subscribe("specpi:guard-policy-changed", () => controller.invalidate("guard policy changed"));
        subscribe("specpi:task-contract-changed", (event) => {
            if (event?.digest !== event?.previousDigest) {
                controller.invalidate("task contract changed");
            }
        });
        let scopeBinding;
        subscribe("specpi:workflow-status", (event) => {
            const next = JSON.stringify({
                active: event?.active,
                generation: event?.generation,
                taskStale: event?.taskStale,
            });
            if (scopeBinding !== undefined && scopeBinding !== next) {
                controller.invalidate("workflow scope changed");
            }

            scopeBinding = next;
        });
        for (const event of [
            "session_before_switch",
            "session_before_fork",
            "session_before_tree",
            "session_tree",
            "model_select",
            "thinking_level_select",
        ]) {
            pi.on(event, () => {
                if (isBound()) {
                    controller.invalidate(event);
                }
            });
        }

        pi.on("session_start", (_event, ctx) => {
            if (!isBound()) {
                return;
            }

            currentContext = ctx;
            prepareContext(ctx, true);
            toolsReady = true;
            controller.invalidate("session started or resources reloaded");
        });
        pi.on("session_shutdown", () => {
            if (!isBound()) {
                return;
            }

            controller.invalidate("session shutdown");
            prepareContext(undefined, true);
            detach();
            currentContext = undefined;
            toolsReady = false;
            bindingEpoch += 1;
        });
        pi.on("before_agent_start", () => {
            if (isBound() && controller.status().enabled) {
                return {
                    message: {
                        customType: "specpi-delegation-policy",
                        content:
                            "Delegation is enabled for independent review of frozen work or substantial selected-source analysis. Stay with one agent for small edits, routine searches, sequential debugging, unsettled interfaces or duplicate opinions. Prefer parallel tools for straightforward retrieval. Give each worker a distinct question and only its requirement IDs, relevant constraints and evidence, without your reasoning or verdict. Use one worker unless two questions are independently useful. State independent parent work only when claiming parallelism; a final review may wait. collect can wait up to 30000ms. Verify source references and resolve findings. You remain the sole writer; delegation is experimental and no SpecPi quality/cost improvement has been measured.",
                        display: false,
                    },
                };
            }
        });
        pi.registerCommand("delegate", {
            description: "Enable bounded read-only delegation or inspect its session limits",
            getArgumentCompletions: (prefix) =>
                ["on", "off", "status", "limits", "cancel"]
                    .filter((value) => value.startsWith(prefix.trim()))
                    .map((value) => ({ value, label: value })),
            handler: async (args, ctx) => {
                if (!isBound()) {
                    ctx.ui.notify("Delegation was reloaded; use the current command.", "error");

                    return;
                }

                currentContext = ctx;
                const [action = "status", id, extra] = args.trim().split(/\s+/u).filter(Boolean);
                try {
                    if (extra || (id && action !== "cancel")) {
                        throw new Error("Usage: /delegate [on|off|status|limits|cancel <batchId>]");
                    }

                    if (action === "on") {
                        if (!ctx.hasUI) {
                            throw new Error("Delegation activation requires a human interactive command");
                        }

                        prepareContext(ctx);
                        const host = getHost();
                        await host?.ready?.();
                        if (!isBound() || getHost() !== host) {
                            throw new Error(
                                "Pi changed during delegation setup; enable delegation in the current session",
                            );
                        }

                        const state = controller.enable();
                        syncActiveTool(true);
                        ctx.ui.notify(
                            `Delegation enabled: Pi child sessions for review and scout, ${state.model.provider}/${state.model.id}, thinking ${state.model.thinkingLevel ?? "Pi configured"}. At most 2 workers, 4 batches and 32 SDK inference calls per Pi process; 120 seconds per job. Workers see only supplied text and selected snapshots. Pi owns configured authentication; temporary parent provider/auth overrides and parent hooks are not inherited. No shell, edits, recursion, automatic retries or compaction. /delegate off cancels workers; SDK requests still settling retain their slots. These limits do not guarantee remote termination or a billing cap.`,
                            "info",
                        );
                    } else if (action === "off") {
                        controller.invalidate("disabled by human");
                        ctx.ui.notify(
                            "Delegation disabled. Existing requests are aborted; budgets remain consumed.",
                            "info",
                        );
                    } else if (action === "cancel" && id) {
                        await controller.execute({
                            operation: "cancel",
                            requestId: `human-${randomUUID()}`,
                            batchId: id,
                        });
                        ctx.ui.notify("Batch cancelled. Provider settlement may still be pending.", "info");
                    } else if (["status", "limits"].includes(action)) {
                        ctx.ui.notify(JSON.stringify(controller.status(), null, 2), "info");
                    } else {
                        throw new Error("Usage: /delegate [on|off|status|limits|cancel <batchId>]");
                    }
                } catch (error) {
                    ctx.ui.notify(error.message, "error");
                }
            },
        });
        pi.registerTool({
            name: "delegate",
            label: "Delegate",
            description:
                "Delegate an independent frozen review or substantial selected-source analysis to a real Pi child session. Only after human /delegate on. review: check artifacts against assigned requirements in fresh context; scout: answer a distinct evidence question over selected sources. Prefer one worker and parent-only execution for small, sequential or routine work. No shell, edits or live web. run returns immediately; collect waits for advisory evidence, then resolve findings after verification. One changed-input follow_up shares the original budget/deadline. Never grants permission or proves task completion.",
            parameters: DELEGATE_SCHEMA,
            execute: async (_id, input, signal, _update, ctx) => {
                try {
                    if (!isBound()) {
                        throw new Error("Delegation was reloaded; use the current tool");
                    }

                    currentContext = ctx;
                    prepareContext(ctx);
                    const output = await controller.execute(input, signal);

                    return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `Delegation: ${error.message}` }],
                        details: { error: true },
                        isError: true,
                    };
                }
            },
        });
    };

    return factory;
}

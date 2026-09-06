import { DelegationError, publicErrorMessage } from "./errors.mjs";
import { randomUUID } from "node:crypto";
import { createDelegationController } from "./core.mjs";
import { DEFAULT_TIMEOUT_MINUTES, timeoutLimits } from "./protocol.mjs";
import { createLivePanel, createToolRenderers, readableLimits, readableStatus } from "./presentation.mjs";

const USAGE = "Usage: /delegate [on|off|status|limits|timeout [<minutes>|reset]|cancel <batchId>]";

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
    { root = process.cwd(), controllerOptions = {}, prepareContext = () => {}, presentation, timeoutStore } = {},
) {
    let currentPi;
    let currentContext;
    let toolsReady = false;
    let bindingEpoch = 0;
    let detach = () => {};

    let requested = false;
    let startupActivation = true;
    let requestedGuard;
    let boundHost;
    let pending;
    let pauseReason;

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
        onChange: updatePresentation,
    });
    let timeoutLoaded = !timeoutStore;
    const loadTimeout = () => {
        if (!timeoutLoaded) {
            controller.setTimeoutMinutes(timeoutStore.load());
            timeoutLoaded = true;
        }
    };

    const panel = presentation ? createLivePanel(() => controller.presentation(), presentation) : undefined;

    const status = () => ({
        ...controller.status(),
        requested,
        updating: Boolean(pending),
        pauseReason: pauseReason ?? null,
    });

    function updatePresentation() {
        const state = controller.status();
        syncActiveTool(state.enabled);
        currentContext?.ui?.setStatus?.(
            "specpi-delegation",
            state.enabled
                ? `Delegate ${state.active}/${state.limits.concurrency} workers · ${state.sessionCalls}/${state.limits.sessionCalls} calls`
                : requested
                  ? pending
                      ? "Delegate updating model"
                      : "Delegate paused"
                  : undefined,
        );
        panel?.update();
    }

    function invalidate(reason, preserveStartupDefault = false) {
        if (!preserveStartupDefault) {
            startupActivation = false;
        }

        requested = false;
        pending = undefined;
        boundHost = undefined;
        pauseReason = undefined;
        controller.invalidate(reason);
    }

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
        panel?.dispose();
        detach();
        bindingEpoch += 1;
        const issuedEpoch = bindingEpoch;
        const isBound = () => issuedEpoch === bindingEpoch;
        toolsReady = false;
        prepareContext(undefined, true);
        invalidate("runtime factory rebound", true);
        currentPi = pi;
        currentContext = undefined;
        const refreshSelection = async (ctx) => {
            if (!isBound() || !requested) {
                return;
            }

            currentContext = ctx;
            if (getGuard() !== requestedGuard) {
                invalidate("guard policy changed");

                return;
            }

            let host;
            try {
                prepareContext(ctx);
                host = getHost();
            } catch (error) {
                pending = undefined;
                boundHost = undefined;
                pauseReason = publicErrorMessage(error);
                controller.invalidate("model setup failed");

                return;
            }

            if (boundHost === host && controller.status().enabled) {
                return;
            }

            if (pending && pending.host === host) {
                return pending.promise;
            }

            const attempt = { host, promise: undefined };
            pending = attempt;
            boundHost = undefined;
            pauseReason = undefined;
            controller.invalidate("model or thinking level changed");
            const isCurrent = () => isBound() && requested && pending === attempt;
            attempt.promise = (async () => {
                try {
                    await host?.ready?.();
                    if (!isCurrent()) {
                        return;
                    }

                    if (getGuard() !== requestedGuard) {
                        invalidate("guard policy changed during model setup");

                        return;
                    }

                    if (getHost() !== host) {
                        throw new DelegationError(
                            "Pi changed during model setup; delegation will refresh before the next turn.",
                        );
                    }

                    controller.enable();
                    boundHost = host;
                } catch (error) {
                    if (isCurrent()) {
                        pauseReason = publicErrorMessage(error);
                    }
                } finally {
                    if (pending === attempt) {
                        pending = undefined;
                        updatePresentation();
                    }
                }
            })();

            return attempt.promise;
        };

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
        subscribe("specpi:guard-policy-changed", () => invalidate("guard policy changed"));
        subscribe("specpi:task-contract-changed", (event) => {
            if (event?.digest !== event?.previousDigest) {
                invalidate("task contract changed");
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
                invalidate("workflow scope changed");
            }

            scopeBinding = next;
        });
        for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_tree"]) {
            pi.on(event, () => {
                if (isBound()) {
                    invalidate(event);
                }
            });
        }

        for (const event of ["model_select", "thinking_level_select"]) {
            pi.on(event, async (_event, ctx) => {
                await refreshSelection(ctx);
                if (isBound() && requested && pauseReason) {
                    ctx.ui.notify(`Delegation paused: ${pauseReason}`, "warning");
                }
            });
        }

        pi.on("session_start", async (_event, ctx) => {
            if (!isBound()) {
                return;
            }

            currentContext = ctx;
            toolsReady = true;
            panel?.bind(ctx);
            invalidate("session started or resources reloaded", true);
            try {
                loadTimeout();
                prepareContext(ctx, true);
                // Consume the default only after synchronous preparation, which
                // may revoke it. Off and safety events cancel it even before startup.
                const activate = startupActivation;
                startupActivation = false;
                if (activate && isBound()) {
                    requested = true;
                    requestedGuard = getGuard();
                    await refreshSelection(ctx);
                    if (isBound() && requested && pauseReason) {
                        ctx.ui.notify(`Delegation paused: ${pauseReason}`, "warning");
                    }
                }
            } catch (error) {
                pauseReason = publicErrorMessage(error);
                ctx.ui.notify(`Delegation unavailable: ${pauseReason}`, "warning");
            } finally {
                startupActivation = false;
            }
        });
        pi.on("session_shutdown", () => {
            if (!isBound()) {
                return;
            }

            invalidate("session shutdown");
            panel?.dispose();
            prepareContext(undefined, true);
            detach();
            currentContext = undefined;
            toolsReady = false;
            bindingEpoch += 1;
        });
        pi.on("before_agent_start", async (_event, ctx) => {
            await refreshSelection(ctx);
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
            description:
                "Control read-only delegation (on at Pi startup), inspect limits, or save timeout <minutes> (1–60; reset: 10)",
            getArgumentCompletions: (prefix) =>
                [
                    "on",
                    "off",
                    "status",
                    "limits",
                    "timeout",
                    "timeout 5",
                    "timeout 10",
                    "timeout 15",
                    "timeout 30",
                    "timeout 60",
                    "timeout reset",
                    "cancel",
                ]
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
                    if (extra || (id && !["cancel", "timeout"].includes(action))) {
                        throw new DelegationError(USAGE);
                    }

                    if (action === "on") {
                        if (!ctx.hasUI) {
                            throw new DelegationError("Delegation activation requires a human interactive command");
                        }

                        loadTimeout();
                        requested = true;
                        requestedGuard = getGuard();
                        await refreshSelection(ctx);
                        if (!isBound() || !requested) {
                            throw new DelegationError(
                                "Pi changed during delegation setup; enable delegation in the current session",
                            );
                        }

                        const state = controller.status();
                        if (!state.enabled) {
                            throw new DelegationError(pauseReason ?? "Delegation model setup is still pending.");
                        }

                        syncActiveTool(true);
                        ctx.ui.notify(
                            `Delegation enabled: Pi child sessions for review and scout, ${state.model.provider}/${state.model.id}, thinking ${state.model.thinkingLevel ?? "Pi configured"}. At most 2 workers, 4 batches and 32 SDK inference calls per Pi process; ${state.limits.jobMs / 60_000} minutes per job, ${state.limits.batchMs / 60_000} minutes per batch. Configure with /delegate timeout <minutes> while off (saved across restarts). Workers see only supplied text and selected snapshots. Pi owns configured authentication; temporary parent provider/auth overrides and parent hooks are not inherited. No shell, edits, recursion, automatic retries or compaction. /delegate off cancels workers; SDK requests still settling retain their slots. These limits do not guarantee remote termination or a billing cap.`,
                            "info",
                        );
                    } else if (action === "timeout") {
                        if (id) {
                            if (!ctx.hasUI) {
                                throw new DelegationError("Timeout changes require a human interactive command");
                            }

                            if (requested || pending || controller.status().enabled) {
                                throw new DelegationError(
                                    "Turn delegation off before changing its timeout: /delegate off",
                                );
                            }

                            const minutes =
                                id === "reset" ? DEFAULT_TIMEOUT_MINUTES : /^\d+$/u.test(id) ? Number(id) : NaN;
                            timeoutLimits(minutes);
                            if (!timeoutStore) {
                                throw new DelegationError("Persistent delegation settings are unavailable");
                            }

                            timeoutStore.save(minutes);
                            controller.setTimeoutMinutes(minutes);
                            timeoutLoaded = true;
                        } else {
                            loadTimeout();
                        }

                        const limits = controller.status().limits;
                        ctx.ui.notify(
                            `Delegation timeout: ${limits.jobMs / 60_000} minutes per job; ${limits.batchMs / 60_000} minutes per batch, including queue and follow-up time. ${id ? "Saved for this process and future Pi starts. " : ""}Use /delegate timeout <minutes> (1–60) or /delegate timeout reset (10). Changes require /delegate off; call budgets do not reset.`,
                            "info",
                        );
                    } else if (action === "off") {
                        invalidate("disabled by human");
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
                        const state = status();
                        ctx.ui.notify(action === "limits" ? readableLimits(state) : readableStatus(state), "info");
                    } else {
                        throw new DelegationError(USAGE);
                    }
                } catch (error) {
                    ctx.ui.notify(publicErrorMessage(error), "error");
                }
            },
        });
        pi.registerTool({
            name: "delegate",
            label: "Delegate",
            description:
                "Delegate an independent frozen review or substantial selected-source analysis to a real Pi child session. Enabled by default at Pi startup; respect /delegate off and safety revocations. review: check artifacts against assigned requirements in fresh context; scout: answer a distinct evidence question over selected sources. Prefer one worker and parent-only execution for small, sequential or routine work. No shell, edits or live web. run returns immediately; collect waits for advisory evidence, then resolve findings after verification. One changed-input follow_up shares the original budget/deadline. Never grants permission or proves task completion.",
            parameters: DELEGATE_SCHEMA,
            ...(presentation ? createToolRenderers(presentation) : {}),
            execute: async (_id, input, signal, _update, ctx) => {
                try {
                    if (!isBound()) {
                        throw new DelegationError("Delegation was reloaded; use the current tool");
                    }

                    currentContext = ctx;
                    prepareContext(ctx);
                    const result = await controller.execute(input, signal);
                    const output = input.operation === "status" ? status() : result;

                    return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `Delegation: ${publicErrorMessage(error)}` }],
                        details: { error: true },
                        isError: true,
                    };
                } finally {
                    try {
                        updatePresentation();
                    } catch {
                        // Optional terminal rendering cannot change a tool's outcome.
                    }
                }
            },
        });
    };

    return factory;
}

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
                reason: object({ deliverable: string, consumer: string, independence: string, parentWork: string }),
                jobs: {
                    type: "array",
                    minItems: 1,
                    maxItems: 4,
                    items: object({
                        id: string,
                        mode: { type: "string", enum: ["review", "investigate", "consult", "research"] },
                        question: string,
                        context: string,
                        sources: strings,
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

/** Not auto-discovered by ordinary Pi: the SDK launcher supplies the private closure capability. */
export function createDelegationExtension(getHost, { root = process.cwd(), controllerOptions = {} } = {}) {
    let currentPi;
    let currentContext;
    const getGuard = () => {
        let replies = 0;
        let mode;
        currentPi?.events.emit("specpi:guard-state", {
            reply(value) {
                replies += 1;
                mode = value?.mode;
            },
        });

        return replies === 1 ? mode : undefined;
    };

    const controller = createDelegationController({
        ...controllerOptions,
        getHost,
        root,
        getGuard,
        onChange() {
            const state = controller.status();
            currentContext?.ui?.setStatus?.(
                "specpi-delegation",
                state.enabled
                    ? `Delegate ${state.active}/${state.limits.concurrency} · ${state.sessionCalls}/${state.limits.sessionCalls} calls`
                    : undefined,
            );
        },
    });

    const factory = (pi) => {
        controller.invalidate("runtime factory rebound");
        currentPi = pi;
        const subscriptions = [];
        const subscribe = (name, handler) => {
            const off = pi.events.on(name, handler);
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
            pi.on(event, () => controller.invalidate(event));
        }

        pi.on("session_start", (_event, ctx) => {
            currentContext = ctx;
            controller.invalidate("session started or resources reloaded");
        });
        pi.on("session_shutdown", () => {
            controller.invalidate("session shutdown");
            for (const off of subscriptions) {
                off();
            }

            currentContext = undefined;
        });
        pi.on("before_agent_start", () => {
            if (controller.status().enabled) {
                return {
                    message: {
                        customType: "specpi-delegation-policy",
                        content:
                            "Delegation is explicitly enabled under experimental calls/time limits. Prefer your own execution unless an independent bounded question pays for handoff and verification. Use delegate run while you do useful parent work, then collect (waitMs up to 30000 if needed), verify evidence, and resolve every report. Workers have only inline context or selected text snapshots; research has no live web. You remain the sole writer. No transcript inheritance, automatic routing, recursive delegation, or automatic retries. Cancellation can leave requests settling. Parent assessment is not human approval or task completion. Use status to inspect remaining limits.",
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

                        const state = controller.enable();
                        ctx.ui.notify(
                            `Delegation enabled: experimental calls/time policy, exact parent model ${state.model.provider}/${state.model.id}, at most 2 read-only workers, 4 batches and 48 model calls for this launcher. Jobs expire after 120 seconds. Selected text is sent to the configured provider. Configurable retries are disabled; hidden transport retries and provider buffering are not hard-bounded. Cost is unavailable. /delegate off revokes workers; unsettled requests keep their slots.`,
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
                "Bounded read-only workers, only after human /delegate on. Same parent model. Four profiles: tool-free review/consult; investigate/research read selected immutable repository text (no live web). run requires explicit requirements, non-goals, reason and source filenames. Return immediately and continue useful parent work; collect returns structured advisory results with receipts. Resolve each finding after checking evidence. One changed-input follow-up retains budgets and deadline. Cancellation revokes tools but may leave provider settlement pending. Never a source of write permission or verified completion.",
            parameters: DELEGATE_SCHEMA,
            execute: async (_id, input, signal, _update, ctx) => {
                currentContext = ctx;
                try {
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

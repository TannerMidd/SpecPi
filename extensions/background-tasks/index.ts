import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decideCommand } from "../command-guard/core.mjs";
import { LIMITS, TaskRunner, normalizeStart, preview, record } from "./core.mjs";

function fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function result(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

export default function registerBackgroundTasks(
    pi: ExtensionAPI,
    dependencies: { runner?: any; approvalMs?: number } = {},
) {
    let runner = dependencies.runner ?? new TaskRunner();
    let generation = 0;
    let active = false;
    let pending = 0;
    const approvals = new Set<string>();
    let lifecycle = new AbortController();
    const invalidate = () => {
        generation += 1;
        approvals.clear();
        lifecycle.abort();
        lifecycle = new AbortController();
    };

    let unsubscribe: (() => void) | undefined;
    const subscribe = () => {
        unsubscribe ??= pi.events.on("specpi:guard-policy-changed", invalidate);
    };

    subscribe();
    const admission = (spec: any, hasUI: boolean) => {
        let stateReplies = 0;
        pi.events.emit("specpi:guard-state", {
            reply() {
                stateReplies += 1;
            },
        });
        const replies: any[] = [];
        pi.events.emit("specpi:background-admission", {
            input: { command: spec.command },
            cwd: spec.cwd,
            shell: spec.dialect,
            hasUI,
            reply(value: unknown) {
                replies.push(value);
            },
        });
        if (stateReplies === 0 && replies.length === 0) {
            const decision = decideCommand(spec.command, {
                mode: "guard",
                shell: spec.dialect,
                cwd: spec.cwd,
                platform: process.platform,
                hasUI,
                cache: false,
            });

            return { mode: "absent-guard-policy", generation: 0, action: decision.action, reason: decision.reason };
        }

        const policy = replies[0];
        if (
            stateReplies !== 1 ||
            replies.length !== 1 ||
            !["guard", "strict", "off", "locked"].includes(policy?.mode) ||
            !Number.isSafeInteger(policy?.generation) ||
            !["allow", "ask", "deny"].includes(policy?.action)
        ) {
            throw new Error("Background Guard policy is unavailable or ambiguous; start denied.");
        }

        return policy;
    };

    const cleanup = async (_event: unknown, ctx: any) => {
        active = false;
        invalidate();
        const outcomes = await runner.shutdown();
        const unconfirmed = outcomes.filter((task: any) => task.cleanup !== "confirmed");
        if (unconfirmed.length) {
            ctx.ui.notify(
                `Background cleanup unconfirmed for ${unconfirmed.map((task: any) => task.id).join(", ")}. Processes may still be running. background_start is disabled in this runtime: retry background_stop for these IDs, then /reload after cleanup confirms. IDs do not survive runtime replacement; inspect any remaining processes manually.`,
                "warning",
            );
        }
    };

    pi.on("session_shutdown", async (event, ctx) => {
        await cleanup(event, ctx);
        unsubscribe?.();
        unsubscribe = undefined;
    });
    pi.on("session_start", async (event, ctx) => {
        subscribe();
        if (runner.list().length) {
            await cleanup(event, ctx);
        }

        if (runner.list().some((task: any) => task.cleanup !== "confirmed")) {
            return;
        }

        if (runner.closed) {
            runner = dependencies.runner ?? new TaskRunner();
        }

        invalidate();
        active = true;
    });
    pi.on("session_tree", async (event, ctx) => {
        await cleanup(event, ctx);
        if (!runner.list().some((task: any) => task.cleanup !== "confirmed")) {
            runner = dependencies.runner ?? new TaskRunner();
            active = true;
        }
    });

    pi.registerTool({
        name: "background_start",
        label: "Start background task",
        description:
            "Start a session-owned noninteractive command after explicit approval. Uses /bin/sh on POSIX and system cmd.exe on Windows, not Pi Bash configuration. Four active tasks; 30 minute default timeout, eight hour maximum. Inherits the process environment. Not a sandbox or proof of service readiness.",
        promptSnippet: "Start an approved long-running command while other work continues",
        promptGuidelines: [
            "Never use background_start to reroute a denied command. Use background_logs to observe progress and background_stop when a task is no longer needed. Spawn success is not readiness or completion evidence.",
        ],
        parameters: Type.Object(
            {
                command: Type.String({ minLength: 1, maxLength: LIMITS.command }),
                cwd: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.cwd })),
                label: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.label })),
                timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.timeout })),
            },
            { additionalProperties: false },
        ),
        async execute(_id, input, signal, _update, ctx) {
            if (!active || !ctx.hasUI || pending >= LIMITS.active) {
                throw new Error(
                    "Background starts require an active session, approval UI, and an available admission slot.",
                );
            }

            pending += 1;
            try {
                const spec = normalizeStart(input, ctx.cwd);
                const policy = admission(spec, ctx.hasUI);
                if (policy.action === "deny") {
                    throw new Error(preview(policy.reason));
                }

                const epoch = generation;
                const key = fingerprint({ spec, policy, generation: epoch });
                const abort = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
                abort.throwIfAborted();
                if (!approvals.has(key)) {
                    const controller = new AbortController();
                    const promptSignal = AbortSignal.any([abort, controller.signal]);
                    const timer = setTimeout(() => controller.abort(), dependencies.approvalMs ?? 600000);
                    let cancel: () => void = () => {};

                    try {
                        const cancelled = new Promise<boolean>((resolve) => {
                            cancel = () => resolve(false);
                            promptSignal.addEventListener("abort", cancel, { once: true });
                        });
                        const confirmed = await Promise.race([
                            ctx.ui.confirm(
                                "Start background command for this session?",
                                `Shell: ${preview(spec.shell)}\nCwd: ${preview(spec.cwd, LIMITS.cwd)}\nCommand: ${preview(spec.command, LIMITS.command)}\nTimeout: ${spec.timeoutSeconds}s\nGuard: ${preview(policy.mode)} — ${preview(policy.reason)}\nRuns with your permissions and inherited environment. Not a sandbox. Approves this exact execution for this session; output may enter conversation/provider retention.`,
                                { signal: promptSignal },
                            ),
                            cancelled,
                        ]);
                        if (!confirmed || promptSignal.aborted) {
                            throw new Error("Background command was not approved.");
                        }
                    } finally {
                        clearTimeout(timer);
                        promptSignal.removeEventListener("abort", cancel);
                    }
                }

                abort.throwIfAborted();
                const current = normalizeStart(input, ctx.cwd);
                const currentPolicy = admission(current, ctx.hasUI);
                if (
                    !active ||
                    !ctx.hasUI ||
                    epoch !== generation ||
                    currentPolicy.action === "deny" ||
                    fingerprint({ spec: current, policy: currentPolicy, generation }) !== key
                ) {
                    throw new Error("Background input or policy changed during approval; start denied.");
                }

                while (approvals.size >= LIMITS.approvals && !approvals.has(key)) {
                    approvals.delete(approvals.values().next().value!);
                }

                approvals.add(key);

                return result(await runner.start(current, generation, abort));
            } finally {
                pending -= 1;
            }
        },
    });
    pi.registerTool({
        name: "background_list",
        label: "List background tasks",
        description:
            "List at most four active and 32 completed session tasks with bounded redacted previews and cleanup outcomes.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute(_id, input) {
            record(input, []);

            return result(runner.list());
        },
    });
    pi.registerTool({
        name: "background_logs",
        label: "Read background output",
        description:
            "Read untrusted memory-only task output after an absolute byte offset. At most 64 KiB raw output per read from a 256 KiB ring; stream markers count toward offsets. Terminal controls are escaped; truncation and lost bytes are explicit. Returned text may enter conversation/provider retention.",
        parameters: Type.Object(
            {
                id: Type.String({ minLength: 1, maxLength: 36 }),
                offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
            },
            { additionalProperties: false },
        ),
        async execute(_id, input, signal) {
            record(input, ["id", "offset"]);
            signal?.throwIfAborted();
            const task = runner.get(input.id);

            return result({ id: task.id, status: task.status, ...task.ring.read(input.offset) });
        },
    });
    pi.registerTool({
        name: "background_stop",
        label: "Stop background task",
        description:
            "Idempotently request bounded termination of an owned task. Available under Guard locks. Reports confirmed or unconfirmed cleanup; escaped descendants are not contained.",
        parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 36 }) }, { additionalProperties: false }),
        async execute(_id, input) {
            record(input, ["id"]);

            return result(await runner.stop(input.id));
        },
    });
}

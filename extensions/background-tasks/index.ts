import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decideCommand } from "../command-guard/core.mjs";
import { LIMITS, TaskRunner, normalizeStart, preview, record } from "./core.mjs";
import {
    VerificationRegistry,
    captureInputs,
    normalizeVerification,
    verificationOutput,
    VERIFY_LIMITS,
} from "./verification.mjs";

function fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function result(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

export default function registerBackgroundTasks(
    pi: ExtensionAPI,
    dependencies: {
        runner?: Pick<TaskRunner, "closed" | "list" | "shutdown" | "start" | "get" | "stop" | "wait">;
        approvalMs?: number;
    } = {},
) {
    let runner = dependencies.runner ?? new TaskRunner();
    const verification = new VerificationRegistry();
    let generation = 0;
    let active = false;
    let pending = 0;
    const approvals = new Set<string>();
    let lifecycle = new AbortController();
    const invalidate = () => {
        generation += 1;
        approvals.clear();
        verification.invalidate();
        lifecycle.abort();
        lifecycle = new AbortController();
    };

    let unsubscribe: (() => void) | undefined;
    let unsubscribeReceipts: (() => void) | undefined;
    const subscribe = () => {
        unsubscribe ??= pi.events.on("specpi:guard-policy-changed", invalidate);
        unsubscribeReceipts ??= pi.events.on("specpi:verification-receipts", (request: any) => {
            if (!active || typeof request?.reply !== "function") {
                return;
            }

            try {
                request.reply(
                    request.id ? verification.resolve(request.id, request.root) : verification.list(request.root),
                );
            } catch {
                // Match the requested shape: a list caller expects an array, and an
                // unreadable workspace must read as no current evidence, not as one
                // unknown receipt.
                request.reply(
                    request.id ? { id: request.id, status: "unknown", reason: "Receipt workspace unavailable." } : [],
                );
            }
        });
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
        unsubscribeReceipts?.();
        unsubscribeReceipts = undefined;
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

    const verificationBinding = async (input: unknown, cwd: string) => {
        let root = cwd;
        try {
            const resolved = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 15000 });
            if (resolved.code === 0 && resolved.stdout.trim()) {
                root = path.resolve(cwd, resolved.stdout.trim());
            }
        } catch {
            // Match workflow controls: non-Git workspaces use their session cwd.
        }

        return normalizeVerification(input, cwd, root);
    };

    const executeStart =
        (finite: boolean) =>
        async (_id: string, input: any, signal: AbortSignal | undefined, _update: any, ctx: any) => {
            if (!active || !ctx.hasUI || pending >= LIMITS.active) {
                throw new Error(
                    "Background starts require an active session, approval UI, and an available admission slot.",
                );
            }

            pending += 1;
            try {
                const entryEpoch = generation;
                const entryCwd = ctx.cwd;
                const binding = finite ? await verificationBinding(input, entryCwd) : undefined;
                if (entryEpoch !== generation || entryCwd !== ctx.cwd || !active || !ctx.hasUI) {
                    throw new Error("Verification session changed during workspace resolution.");
                }

                const spec = binding?.spec ?? normalizeStart(input, ctx.cwd);
                const policy = admission(spec, ctx.hasUI);
                // Decide admission before reading anything: a capture failure on a
                // denied command would otherwise hide the denial behind a
                // filesystem message and invite a retry with narrower inputs.
                if (policy.action === "deny") {
                    throw new Error(preview(policy.reason));
                }

                const before = binding ? captureInputs(binding.root, binding.inputs) : undefined;
                const epoch = generation;
                const key = fingerprint({ spec, policy, generation: epoch, binding, before: before?.digest });
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
                                finite
                                    ? "Run verification command for this session?"
                                    : "Start background command for this session?",
                                `Shell: ${preview(spec.shell)}\nCwd: ${preview(spec.cwd, LIMITS.cwd)}\nCommand: ${preview(spec.command, LIMITS.command)}\nTimeout: ${spec.timeoutSeconds}s\nGuard: ${preview(policy.mode)} — ${preview(policy.reason)}${binding ? `\nDeclared inputs (workspace relative): ${binding.inputs.map((value: string) => preview(value, 240)).join(", ")}\nInput snapshot: ${before?.digest}${before?.skipped ? `\nSkipped inside declared directories: ${before.skipped} excluded entr${before.skipped === 1 ? "y" : "ies"} (dependency trees, caches, credential filenames). These are not covered by this receipt.` : ""}\nInclude source, tests, configuration and lockfiles that affect this check. Only these inputs are tracked.` : ""}\nRuns with your permissions and inherited environment. Not a sandbox. Approves this exact execution for this session; output may enter conversation/provider retention.`,
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
                const currentBinding = finite ? await verificationBinding(input, ctx.cwd) : undefined;
                const current = currentBinding?.spec ?? normalizeStart(input, ctx.cwd);
                const currentPolicy = admission(current, ctx.hasUI);
                const currentBefore = currentBinding
                    ? captureInputs(currentBinding.root, currentBinding.inputs)
                    : undefined;
                if (
                    !active ||
                    !ctx.hasUI ||
                    epoch !== generation ||
                    currentPolicy.action === "deny" ||
                    fingerprint({
                        spec: current,
                        policy: currentPolicy,
                        generation,
                        binding: currentBinding,
                        before: currentBefore?.digest,
                    }) !== key
                ) {
                    throw new Error("Background input or policy changed during approval; start denied.");
                }

                while (approvals.size >= LIMITS.approvals && !approvals.has(key)) {
                    approvals.delete(approvals.values().next().value!);
                }

                approvals.add(key);

                const started = await runner.start(current, generation, abort);
                if (!currentBinding) {
                    return result(started);
                }

                const owned = runner.get(started.id);
                const outcome = await runner.wait(started.id, abort);
                let after;
                try {
                    after = captureInputs(currentBinding.root, currentBinding.inputs);
                } catch {
                    after = undefined;
                }

                if (!active || epoch !== generation) {
                    // Same shape the registry returns, so a caller can read `status`
                    // without first working out which branch produced the result.
                    return result({
                        id: started.id,
                        status: "unknown",
                        reason: "Verification session or policy changed; no live receipt was retained.",
                        outcome,
                    });
                }

                // An ordinary cancellation is a failed attempt in this still-current
                // session. Keep it so a cancelled rerun cannot leave an older pass latest.
                const receipt = verification.add(
                    currentBinding,
                    currentBefore,
                    after,
                    outcome,
                    verificationOutput(owned.ring),
                );

                return result(verification.resolve(receipt.id, currentBinding.root));
            } finally {
                pending -= 1;
            }
        };

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
        execute: executeStart(false),
    });
    pi.registerTool({
        name: "verify_run",
        label: "Run verification check",
        description:
            "Run a finite, explicitly approved project check with Guard admission and shared background task limits. Returns an in-memory receipt of observed exit, cleanup, output and before/after hashes of declared inputs. Declare source, tests, configuration and lockfiles; this is not a sandbox, hermetic execution or proof of requirement coverage.",
        promptSnippet: "Run an approved check and record source-bound evidence",
        parameters: Type.Object(
            {
                command: Type.String({ minLength: 1, maxLength: LIMITS.command }),
                cwd: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.cwd })),
                label: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.label })),
                timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.timeout })),
                inputs: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), {
                    minItems: 1,
                    maxItems: VERIFY_LIMITS.declarations,
                }),
            },
            { additionalProperties: false },
        ),
        execute: executeStart(true),
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

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir } from "../browser/core.mjs";
import { LANGUAGES, SearchError, normalizeSearch, structuralSearch } from "./core.mjs";
import { readIntegrations } from "./config.mjs";

type Policy = { mode: string; generation: number; action: string };
export default function registerStructuralSearch(pi: ExtensionAPI) {
    const agentDir = getAgentDir(import.meta.url);
    let enabled = false;
    try {
        enabled = readIntegrations(agentDir).structuralSearch.enabled;
    } catch {
        // Malformed configuration never enables code execution.
    }

    if (!enabled) {
        return;
    }

    let lifecycle = new AbortController();
    let cleanupFailed = false;
    let pending = 0;
    let tail: Promise<unknown> = Promise.resolve();
    const invalidate = () => {
        lifecycle.abort();
        lifecycle = new AbortController();
    };

    const unsubscribe = pi.events.on("specpi:guard-policy-changed", invalidate);
    pi.on("session_start", invalidate);
    pi.on("session_tree", invalidate);
    pi.on("session_shutdown", () => {
        invalidate();
        unsubscribe();
    });
    function policy(): Policy {
        let states = 0;
        const replies: Policy[] = [];
        pi.events.emit("specpi:guard-state", {
            reply() {
                states += 1;
            },
        });
        pi.events.emit("specpi:structural-admission", {
            reply(value: Policy) {
                replies.push(value);
            },
        });
        if (states === 0 && replies.length === 0) {
            return { mode: "absent", generation: 0, action: "allow" };
        }

        const value = replies[0];
        if (
            states !== 1 ||
            replies.length !== 1 ||
            !["guard", "strict", "off", "locked"].includes(value?.mode) ||
            !Number.isSafeInteger(value.generation) ||
            !["allow", "ask", "deny"].includes(value.action)
        ) {
            throw new SearchError("denied", "Structural search policy unavailable or ambiguous.");
        }

        return value;
    }

    pi.registerTool({
        name: "structural_search",
        label: "Structural Search",
        description:
            "Read-only ast-grep patterns over explicit selected source files. Use literal search for filenames/comments; results do not resolve types or symbols. No rewrite or custom config.",
        parameters: Type.Object(
            {
                language: StringEnum(Object.keys(LANGUAGES)),
                pattern: Type.String(),
                paths: Type.Array(Type.String()),
                maxResults: Type.Optional(Type.Integer()),
                timeoutMs: Type.Optional(Type.Integer()),
            },
            { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_id, input, originalSignal, _update, ctx) {
            const spec = normalizeSearch(input);
            const cwd = path.resolve(ctx.cwd);
            if (pending >= 2) {
                throw new SearchError("denied", "Structural search queue is full.");
            }

            pending += 1;
            let started = false;
            const controller = new AbortController();
            const signal = AbortSignal.any([
                controller.signal,
                lifecycle.signal,
                ...(originalSignal ? [originalSignal] : []),
            ]);
            const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
            const run = async () => {
                started = true;
                if (cleanupFailed) {
                    throw new SearchError(
                        "cleanup_failed",
                        "Previous parser cleanup failed; resolve it before reloading.",
                    );
                }

                if (!readIntegrations(agentDir).structuralSearch.enabled || signal.aborted) {
                    throw new SearchError("denied", "Structural search disabled or cancelled.");
                }

                const granted = policy();
                if (granted.action === "deny") {
                    throw new SearchError("denied", "Command Guard denied structural search.");
                }

                if (granted.action === "ask") {
                    if (!ctx.hasUI) {
                        throw new SearchError("denied", "Strict structural search requires approval UI.");
                    }

                    const prompt = ctx.ui.select(
                        `Read-only structural search ${JSON.stringify({ cwd, language: spec.language, paths: spec.paths, pattern: spec.pattern }).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_")}`,
                        ["Deny", "Allow once"],
                    );
                    let cancelApproval: (() => void) | undefined;
                    let answer;
                    try {
                        answer = await Promise.race([
                            prompt,
                            new Promise<undefined>((resolve) => {
                                cancelApproval = () => resolve(undefined);
                                signal.addEventListener("abort", cancelApproval, { once: true });
                                if (signal.aborted) {
                                    cancelApproval();
                                }
                            }),
                        ]);
                    } finally {
                        if (cancelApproval) {
                            signal.removeEventListener("abort", cancelApproval);
                        }
                    }

                    if (answer !== "Allow once") {
                        throw new SearchError("denied", "Structural search was not approved.");
                    }
                }

                const admit = async () => {
                    const current = policy();
                    if (
                        signal.aborted ||
                        path.resolve(ctx.cwd) !== cwd ||
                        current.action === "deny" ||
                        current.generation !== granted.generation ||
                        current.mode !== granted.mode ||
                        !readIntegrations(agentDir).structuralSearch.enabled
                    ) {
                        throw new SearchError("denied", "Structural search policy changed or request cancelled.");
                    }
                };

                return structuralSearch(spec, {
                    cwd,
                    runtimeDir: path.join(agentDir, "specpi", "structural-runtime"),
                    signal,
                    admit,
                });
            };

            const operation = tail.then(run, run);
            tail = operation
                .catch(() => {})
                .finally(() => {
                    pending -= 1;
                });
            let cancelQueued: (() => void) | undefined;
            try {
                const queuedAbort = new Promise<never>((_resolve, reject) => {
                    cancelQueued = () => {
                        if (!started) {
                            reject(new SearchError("cancelled", "Queued structural search cancelled."));
                        }
                    };

                    signal.addEventListener("abort", cancelQueued, { once: true });
                    if (signal.aborted) {
                        cancelQueued();
                    }
                });
                const value = await Promise.race([operation, queuedAbort]);

                return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
            } catch (error) {
                cleanupFailed ||= error instanceof SearchError && error.status === "cleanup_failed";
                const status = controller.signal.aborted
                    ? "timed_out"
                    : signal.aborted
                      ? "cancelled"
                      : error instanceof SearchError
                        ? error.status
                        : "denied";
                const reason =
                    error instanceof SearchError
                        ? error.message
                        : "Source selection or runtime unavailable; check the explicit files and configuration.";

                return {
                    content: [{ type: "text", text: JSON.stringify({ status, reason }) }],
                    details: {},
                    isError: true,
                };
            } finally {
                clearTimeout(timer);
                if (cancelQueued) {
                    signal.removeEventListener("abort", cancelQueued);
                }
            }
        },
    });
}

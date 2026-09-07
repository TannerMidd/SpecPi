import { stripVTControlCharacters } from "node:util";

// Worker text is untrusted terminal content. Never interpret its ANSI, links or controls.
const plain = (value) =>
    stripVTControlCharacters(String(value ?? "").slice(0, 16000))
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
const duration = (ms) => {
    const seconds = Math.floor(Math.max(0, ms) / 1000);

    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const stateLabel = (job) => {
    if (job.settling && !["running", "queued"].includes(job.state)) {
        return ["complete", "partial", "needs_context"].includes(job.state) ? "finishing" : "stopping";
    }

    return (
        { complete: "ready for review", partial: "partial · needs review", needs_context: "needs context" }[
            job.state
        ] ?? plain(job.state)
    );
};

const stateColor = (job) => {
    if (job.settling || job.state === "running") {
        return "accent";
    }

    return job.state === "complete" ? "success" : "warning";
};

export function panelLines(view, width, theme, truncateToWidth) {
    const fit = (text) => truncateToWidth(text, Math.max(1, width), "…");
    const lines = [
        fit(
            theme.fg("accent", "Delegation") +
                theme.fg(
                    "muted",
                    ` · ${view.active}/${view.concurrency} workers · ${view.calls}/${view.callLimit} calls`,
                ),
        ),
    ];
    for (const job of view.jobs) {
        const state = width < 72 && job.state === "complete" && !job.settling ? "ready" : stateLabel(job);
        const label = theme.fg(stateColor(job), state);
        const identity = `${plain(job.id)} · ${plain(job.mode)}`;
        const metrics = `${duration(job.elapsedMs)} · ${job.calls} model · ${job.tools} tools`;
        if (width < 72) {
            const name = truncateToWidth(identity, Math.max(1, width - state.length - 5), "…");
            lines.push(fit(`  ${name} · ${label}`), fit(theme.fg("dim", `    ${metrics}`)));
        } else {
            const name = truncateToWidth(identity, Math.max(1, width - state.length - metrics.length - 8), "…");
            lines.push(fit(`  ${name} · ${label}` + theme.fg("dim", ` · ${metrics}`)));
        }
    }

    return lines;
}

/** One mounted component and one 1 Hz timer, only in a live TUI with occupied slots. */
export function createLivePanel(getView, { truncateToWidth }) {
    const key = "specpi-delegation-workers";
    let context;
    let timer;
    let tui;
    let mounted = false;
    let view;
    const dispose = () => {
        clearTimeout(timer);
        timer = undefined;
        if (mounted) {
            try {
                context?.ui?.setWidget?.(key, undefined);
            } catch {
                // A closing terminal cannot interrupt session teardown.
            }
        }

        mounted = false;
        tui = undefined;
        context = undefined;
        view = undefined;
    };

    const update = () => {
        clearTimeout(timer);
        timer = undefined;
        if (context?.mode !== "tui" || !context?.ui?.setWidget) {
            return;
        }

        view = getView();
        if (!view.jobs.length) {
            if (mounted) {
                context.ui.setWidget(key, undefined);
                mounted = false;
                tui = undefined;
            }

            return;
        }

        if (!mounted) {
            mounted = true;
            context.ui.setWidget(key, (activeTui, theme) => {
                tui = activeTui;

                return {
                    invalidate() {},
                    render: (width) => (view ? panelLines(view, width, theme, truncateToWidth) : []),
                };
            });
        } else {
            tui?.requestRender();
        }

        if (view.active > 0) {
            timer = setTimeout(() => {
                try {
                    update();
                } catch {
                    // UI failure cannot escape an async timer or affect worker ownership.
                }
            }, 1000);
            timer.unref?.();
        }
    };

    return {
        update,
        dispose,
        bind(ctx) {
            dispose();
            context = ctx;
        },
    };
}

// Versioned display metadata over Pi's supported string-array widget transport.
// Never send snapshots, full prompts, child transcripts or raw provider diagnostics.
export function createRpcPanel(getView) {
    const key = "specpi-delegation-v1";
    let context;
    let timer;
    let signature;
    const dispose = () => {
        clearTimeout(timer);
        timer = undefined;
        if (context?.mode === "rpc") {
            try {
                context.ui.setWidget(key, undefined);
            } catch {
                // UI teardown cannot affect worker ownership.
            }
        }

        context = undefined;
        signature = undefined;
    };

    const update = () => {
        clearTimeout(timer);
        timer = undefined;
        if (context?.mode !== "rpc" || !context.ui?.setWidget) {
            return;
        }

        const view = getView();
        const payload = {
            version: 1,
            enabled: view.enabled,
            active: view.active,
            concurrency: view.concurrency,
            calls: view.calls,
            callLimit: view.callLimit,
            jobs: view.jobs.slice(0, 8).map((job) => ({
                id: job.id,
                batchId: job.batchId,
                attemptId: job.attemptId,
                mode: job.mode,
                state: job.state,
                settling: job.settling,
                calls: job.calls,
                tools: job.tools,
                elapsedMs: job.elapsedMs,
                disposition: job.disposition,
                task: plain(job.task).slice(0, 240),
                provider: plain(job.provider).slice(0, 128),
                model: plain(job.model).slice(0, 128),
                error: job.error ? plain(job.error).slice(0, 512) : null,
            })),
        };
        const next = JSON.stringify(payload);
        if (next !== signature) {
            context.ui.setWidget(key, [next]);
            signature = next;
        }

        if (view.active > 0) {
            timer = setTimeout(() => {
                try {
                    update();
                } catch {
                    // Optional RPC UI failures never escape the sampling timer.
                }
            }, 1000);
            timer.unref?.();
        }
    };

    return {
        update,
        dispose,
        bind(ctx) {
            dispose();
            context = ctx;
        },
    };
}

export function readableStatus(state) {
    const mode = state.enabled ? "enabled" : state.updating ? "updating model" : state.requested ? "paused" : "off";
    const lines = [
        `Delegation ${mode} · ${state.active}/${state.limits.concurrency} workers active`,
        `Process budget: ${state.sessionCalls}/${state.limits.sessionCalls} model calls · ${state.sessionBatches}/${state.limits.sessionBatches} batches used`,
        `Command Guard: ${plain(state.guard)}`,
        `Timeout: ${state.limits.jobMs / 60_000} minutes per job · ${state.limits.batchMs / 60_000} minutes per batch (/delegate timeout)`,
    ];
    if (state.model) {
        lines.push(
            `Model: ${plain(state.model.provider)}/${plain(state.model.id)} · thinking ${plain(state.model.thinkingLevel ?? "configured")}`,
        );
    }

    if (state.pauseReason) {
        lines.push(plain(state.pauseReason));
    }

    for (const batch of state.batches.filter((item) => !item.retired)) {
        lines.push(`Batch ${plain(batch.batchId)}`);
        for (const job of batch.jobs) {
            lines.push(
                `  ${plain(job.jobId)} · ${job.disposition ? plain(job.disposition) : stateLabel(job)} · ${job.calls} model calls`,
            );
        }
    }

    return lines.join("\n");
}

export function readableLimits(state) {
    const limits = Object.entries(state.limits).map(([name, value]) => {
        const unit = name.endsWith("Bytes") ? " bytes" : name.endsWith("Ms") ? " ms" : "";
        const label = name.replace(/(Bytes|Ms)$/u, "").replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);

        return `  ${label}: ${value}${unit}`;
    });

    return `${readableStatus(state)}\nEffective limits:\n${limits.join("\n")}\nBudgets do not reset on off/on or reload. Cancellation is best effort; no billing cap.`;
}

export function createToolRenderers({ truncateToWidth, wrapTextWithAnsi }) {
    const component = (getLines) => {
        let cachedWidth;
        let cachedLines;

        return {
            invalidate() {
                cachedWidth = undefined;
            },
            render(width) {
                if (width === cachedWidth) {
                    return cachedLines;
                }

                const lines = getLines().flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
                const selected =
                    lines.length > 120 ? [...lines.slice(0, 119), "… more in the structured tool response"] : lines;

                cachedWidth = width;
                cachedLines = selected.map((line) => truncateToWidth(line, Math.max(1, width), "…"));

                return cachedLines;
            },
        };
    };

    const references = (items) =>
        (items ?? []).map((item) => `${plain(item.sourceId)}:${item.lineStart}–${item.lineEnd}`).join(", ");

    return {
        renderCall(args, theme) {
            return component(() => {
                const operation = plain(args?.operation || "preparing");
                const jobs = Array.isArray(args?.packet?.jobs)
                    ? args.packet.jobs
                          .slice(0, 2)
                          .map((job) => `${plain(job.id)} (${plain(job.mode)})`)
                          .join(", ")
                    : plain(args?.jobId);

                return [
                    theme.fg("toolTitle", `Delegate · ${operation}`) + (jobs ? theme.fg("muted", ` · ${jobs}`) : ""),
                ];
            });
        },
        renderResult(result, { expanded, isPartial }, theme) {
            return component(() => {
                if (isPartial) {
                    return [theme.fg("muted", "Waiting for worker results…")];
                }

                if (result.isError || result.details?.error) {
                    return [
                        theme.fg(
                            "error",
                            plain(result.content?.find((item) => item.type === "text")?.text ?? "Delegation failed"),
                        ),
                    ];
                }

                const data = result.details ?? {};
                if (typeof data.enabled === "boolean") {
                    return readableStatus(data)
                        .split("\n")
                        .map((line) => theme.fg("muted", line));
                }

                if (data.disposition) {
                    return [
                        theme.fg(
                            "muted",
                            `${plain(data.jobId)} · ${plain(data.disposition.decision)} · parent assessment`,
                        ),
                    ];
                }

                const lines = (data.jobs ?? []).map(
                    (job) =>
                        `${plain(job.jobId)} · ${job.disposition ? plain(job.disposition) : stateLabel(job)} · ${job.calls} model calls`,
                );
                for (const item of data.results ?? []) {
                    if (!item.result) {
                        if (item.error) {
                            lines.push(theme.fg("warning", `${plain(item.receipt?.jobId)}: ${plain(item.error)}`));
                        }

                        continue;
                    }

                    const report = item.result;
                    lines.push(
                        theme.fg(
                            "accent",
                            `${plain(item.receipt?.jobId)} · ${report.findings.length} findings · advisory`,
                        ),
                    );
                    if (expanded) {
                        lines.push(plain(report.answer));
                        for (const finding of report.findings) {
                            lines.push(`${plain(finding.id)} [${plain(finding.confidence)}] ${plain(finding.claim)}`);
                            lines.push(theme.fg("dim", `  Evidence: ${references(finding.evidence) || "none"}`));
                            if (finding.contraryEvidence?.length) {
                                lines.push(theme.fg("dim", `  Contrary: ${references(finding.contraryEvidence)}`));
                            }
                        }

                        for (const requirement of report.requirements) {
                            lines.push(
                                theme.fg(
                                    "dim",
                                    `${plain(requirement.id)} · ${plain(requirement.status)} · ${references(requirement.evidence) || "no references"}`,
                                ),
                            );
                        }

                        for (const missing of report.missing) {
                            lines.push(theme.fg("warning", `Missing: ${plain(missing)}`));
                        }

                        if (report.nextStep) {
                            lines.push(`Next: ${plain(report.nextStep)}`);
                        }
                    }
                }

                if (!expanded && data.results?.some((item) => item.result)) {
                    lines.push(theme.fg("dim", "Expand tool output for findings and evidence."));
                }

                return lines.length ? lines : [theme.fg("muted", "No new worker results.")];
            });
        },
    };
}

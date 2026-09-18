import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SYSTEM_NAMES, keyPresent, loadSettings, saveSettings, settingsPath } from "./config.mjs";
import { consentPath, granted, revokeConsent } from "./consent.mjs";
import { createBroker } from "./broker.mjs";
import { ledgerPath, read as readLedger } from "./ledger.mjs";
import { applyConfig as applyGuardConfig, statusLine as guardStatusLine } from "./guard.mjs";
import * as retention from "./questions/retention.mjs";
import * as compaction from "./questions/compaction.mjs";
import * as gap from "./questions/gap.mjs";
import * as sources from "./questions/sources.mjs";

const MAX_RECENT = 8;

function safeMessage(error: unknown) {
    return String((error as any)?.message ?? error ?? "unknown error").slice(0, 200);
}

export default function jevAdvisor(pi: ExtensionAPI) {
    // Session switches live in memory. A session toggle must never write the startup preference,
    // so the saved file is read once per session and only /jev startup ever writes it.
    let settings = loadSettings();
    const broker = createBroker({ loadSettings: () => settings });
    const recent: { tool: string; outcome: string }[] = [];
    let objective = "";

    const enabled = (system: string) => settings.master && settings.systems[system] === true;

    let guardEnabled = false;
    const syncGuard = () => {
        try {
            return applyGuardConfig(guardEnabled);
        } catch {
            // A guard that cannot be reconfigured keeps whatever posture it has, which
            // /jev status reports rather than hides.
            return { applied: false, reason: "unwritable" };
        }
    };

    pi.on("session_start", () => {
        settings = loadSettings();
        if (!settings.startup) {
            settings = { ...settings, master: false };
        }

        broker.reset();
        recent.length = 0;
        guardEnabled = settings.guard.startup === true;
        // Deliberately outside the master switch. The guard is a separate package with its own
        // gate, and whether it is inert is a property of the install rather than a feature of the
        // advisor, so its configuration is rewritten every session either way. Off is the default
        // and is a real written configuration, not an absence of one.
        syncGuard();
    });

    pi.on("session_shutdown", () => {
        broker.reset();
        recent.length = 0;
    });

    // The task objective is the one piece of context every system wants, and it is already in the
    // system prompt, so reading it here costs nothing extra.
    pi.on("before_agent_start", (event: any) => {
        const match = /\[SPECPI TASK CONTRACT\]\n([^\n]{0,200})/u.exec(event?.systemPrompt ?? "");
        if (match) {
            objective = match[1];
        }
    });

    // System 1: condense a spent tool result before it is appended. Doing this after the fact would
    // rewrite a cached prefix; on arrival it never touches one.
    pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
        if (!enabled("retention") || !retention.eligible(event)) {
            return;
        }

        try {
            const text = retention.resultText(event);
            const bytes = retention.resultBytes(event);
            const result = await broker.request({
                system: "retention",
                state: retention.buildInput({ event, objective, recent }),
                questions: retention.questions(),
                ctx,
                root: ctx.cwd,
            });
            if (!result.ok) {
                return;
            }

            const verdict = retention.decide(result.answers);
            recent.push({ tool: event.toolName, outcome: verdict.elide ? "spent" : "kept" });
            if (recent.length > MAX_RECENT) {
                recent.shift();
            }

            if (!verdict.elide) {
                return;
            }

            // Replace only the text parts. An image part carries no cheap digest and is left whole.
            const images = (event.content ?? []).filter((part: any) => part?.type !== "text");

            return {
                content: [
                    { type: "text" as const, text: retention.digest(text, { tool: event.toolName, bytes }) },
                    ...images,
                ],
            };
        } catch {
            // An advisor that throws must not fail the tool call that produced the result.
            return;
        }
    });

    // System 1b: steer the summary at the one boundary where the prompt cache is discarded anyway.
    // Only customInstructions is supplied; the preparation's own cut and budget are left alone.
    pi.on("session_before_compact", async (event: any, ctx: ExtensionContext) => {
        if (!enabled("compaction")) {
            return;
        }

        try {
            const result = await broker.request({
                system: "compaction",
                state: compaction.buildInput({ preparation: event.preparation, objective }),
                questions: compaction.questions(),
                ctx,
                root: ctx.cwd,
                signal: event.signal,
            });
            if (!result.ok) {
                return;
            }

            const advice = compaction.decide(result.answers);
            if (!advice.customInstructions) {
                return;
            }

            const existing = typeof event.customInstructions === "string" ? event.customInstructions.trim() : "";

            return {
                customInstructions: existing
                    ? `${existing}\n\n${advice.customInstructions}`
                    : advice.customInstructions,
            };
        } catch {
            return;
        }
    });

    pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
        // System 2: triage a capability gap before tool-wishlist writes it. `event.input` is
        // documented as mutable, so this patches the report in place rather than duplicating any
        // of the wishlist's authority logic. Nothing here records a decision.
        if (event.toolName === "report_capability_gap" && enabled("gap")) {
            try {
                const result = await broker.request({
                    system: "gap",
                    state: gap.buildInput({ gap: event.input, existing: [] }),
                    questions: gap.questions({ gap: event.input, existing: [] }),
                    ctx,
                    root: ctx.cwd,
                });
                if (!result.ok) {
                    return;
                }

                const advice = gap.decide(result.answers);
                if (advice.blockForSanitization) {
                    return {
                        block: true,
                        reason: "This report appears to contain a credential, an absolute path or other machine-specific detail. Rewrite it with the specifics removed and report it again.",
                    };
                }

                if (advice.canonicalKey && typeof event.input?.canonicalKey !== "string") {
                    event.input.canonicalKey = advice.canonicalKey;
                }

                if (advice.suggestedFix && !event.input?.suggestedFix) {
                    event.input.suggestedFix = advice.suggestedFix;
                }

                // Recorded alongside the model's own claim, never over it: a human reading the
                // wishlist should still see what was originally reported.
                if (advice.independentImpact) {
                    event.input.independentImpact = advice.independentImpact;
                }
            } catch {
                return;
            }

            return;
        }

        // System 4: order the sources a delegation batch will snapshot. Ordering only — the same
        // set is frozen either way, but a child pages through `list_sources` in this order.
        if (event.toolName === "delegate" && enabled("sources") && Array.isArray(event.input?.sources)) {
            try {
                const candidates = event.input.sources
                    .filter((item: unknown) => typeof item === "string")
                    .map((item: string) => ({ path: item }));
                if (candidates.length < 2) {
                    return;
                }

                const result = await broker.request({
                    system: "sources",
                    state: sources.buildInput({ question: event.input?.question ?? objective, candidates }),
                    questions: sources.questions({ candidates }),
                    ctx,
                    root: ctx.cwd,
                });
                if (!result.ok) {
                    return;
                }

                const ranked = sources.decide(result.answers, candidates);
                const ordered = ranked.ordered.map((item: any) => item.path);
                const missing = event.input.sources.filter((item: string) => !ordered.includes(item));
                event.input.sources = [...ordered, ...missing];
            } catch {
                return;
            }
        }
    });

    pi.registerCommand("jev", {
        description: "Show or change the Jev advisor: master switch, per-system switches and the transmission ledger",
        getArgumentCompletions: (prefix: string) =>
            ["status", "on", "off", "startup", "enable", "disable", "guard", "ledger", "forget"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args: string, ctx: ExtensionContext) => {
            const [actionRaw = "status", ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw.toLowerCase();
            try {
                if (action === "on" || action === "off") {
                    settings = { ...settings, master: action === "on" };
                    const active = SYSTEM_NAMES.filter((name) => settings.systems[name]);
                    ctx.ui.notify(
                        action === "on"
                            ? `Jev advisor on for this session with ${active.length} of ${SYSTEM_NAMES.length} systems enabled${active.length === 0 ? " (enable one with /jev enable <system>)" : `: ${active.join(", ")}`}.`
                            : "Jev advisor off for this session. No state leaves this machine.",
                        "info",
                    );

                    return;
                }

                if (action === "enable" || action === "disable") {
                    const names = rest.map((name) => name.toLowerCase());
                    const unknown = names.filter((name) => !SYSTEM_NAMES.includes(name));
                    if (names.length === 0 || unknown.length > 0) {
                        throw new Error(`Usage: /jev ${action} <${SYSTEM_NAMES.join("|")}>`);
                    }

                    const systems = { ...settings.systems };
                    for (const name of names) {
                        systems[name] = action === "enable";
                    }

                    settings = { ...settings, systems };
                    ctx.ui.notify(
                        `${action === "enable" ? "Enabled" : "Disabled"} for this session: ${names.join(", ")}.${settings.master ? "" : " The master switch is still off; run /jev on."}`,
                        "info",
                    );

                    return;
                }

                if (action === "startup") {
                    const [choice] = rest;
                    if (!choice) {
                        ctx.ui.notify(
                            `Jev starts ${loadSettings().startup ? "on" : "off"} in new sessions. Preference: ${settingsPath()}`,
                            "info",
                        );

                        return;
                    }

                    if (!ctx.hasUI) {
                        throw new Error("Startup changes require a human interactive command");
                    }

                    if (!["on", "off"].includes(choice.toLowerCase())) {
                        throw new Error("Usage: /jev startup [on|off]");
                    }

                    const saved = saveSettings({ ...loadSettings(), startup: choice.toLowerCase() === "on" });
                    ctx.ui.notify(
                        saved.startup
                            ? "New Pi sessions will start with the Jev advisor on. This session is unchanged."
                            : "New Pi sessions will start with the Jev advisor off. This session is unchanged.",
                        "info",
                    );

                    return;
                }

                if (action === "guard") {
                    const [verb, choice] = rest.map((value) => value.toLowerCase());
                    if (!verb) {
                        ctx.ui.notify(guardStatusLine(), "info");

                        return;
                    }

                    if (verb === "on" || verb === "off") {
                        guardEnabled = verb === "on";
                        const result = syncGuard();
                        ctx.ui.notify(
                            result.reason === "not-installed"
                                ? "specpi-jev-guard is not installed, so there is nothing to switch. Command policy stays with the permission system."
                                : guardEnabled
                                  ? "Jev guard on for this session. It scores shell and file calls and defers to the permission system whenever Jev is unavailable or unconfident."
                                  : "Jev guard off for this session. Every tool call goes straight to the permission system.",
                            "info",
                        );

                        return;
                    }

                    if (verb !== "startup") {
                        throw new Error("Usage: /jev guard [on|off|startup [on|off]]");
                    }

                    if (!choice) {
                        ctx.ui.notify(
                            `The Jev guard starts ${loadSettings().guard.startup ? "on" : "off"} in new sessions.`,
                            "info",
                        );

                        return;
                    }

                    if (!ctx.hasUI) {
                        throw new Error("Startup changes require a human interactive command");
                    }

                    if (!["on", "off"].includes(choice)) {
                        throw new Error("Usage: /jev guard startup [on|off]");
                    }

                    const stored = loadSettings();
                    const saved = saveSettings({
                        ...stored,
                        guard: { ...stored.guard, startup: choice === "on" },
                    });
                    ctx.ui.notify(
                        saved.guard.startup
                            ? "New Pi sessions will start with the Jev guard on. This session is unchanged."
                            : "New Pi sessions will start with the Jev guard off. This session is unchanged.",
                        "info",
                    );

                    return;
                }

                if (action === "forget") {
                    if (!ctx.hasUI) {
                        throw new Error("Revoking consent requires a human interactive command");
                    }

                    revokeConsent();
                    ctx.ui.notify(
                        "Forgot the Jev transmission consent. The next system that would send anything will ask again.",
                        "info",
                    );

                    return;
                }

                if (action === "ledger") {
                    const limit = Number.parseInt(rest[0] ?? "10", 10);
                    const entries = readLedger(Number.isInteger(limit) ? limit : 10);
                    if (entries.length === 0) {
                        ctx.ui.notify(`No Jev transmissions recorded. Ledger: ${ledgerPath()}`, "info");

                        return;
                    }

                    const lines = entries.map(
                        (entry: any) =>
                            `${entry.at} ${entry.system} ${entry.stateBytes}B ${entry.ok ? `${entry.latencyMs}ms` : entry.reason} ${String(entry.payloadSha256 ?? "").slice(0, 12)} [${(entry.questionKeys ?? []).join(", ")}]`,
                    );
                    ctx.ui.notify(`${lines.join("\n")}\n\nLedger: ${ledgerPath()}`, "info");

                    return;
                }

                if (action !== "status") {
                    throw new Error(
                        "Usage: /jev [status|on|off|startup [on|off]|enable <system>|disable <system>|guard [on|off|startup [on|off]]|ledger [n]|forget]",
                    );
                }

                const state = broker.status();
                const lines = [
                    `master: ${settings.master ? "on" : "off"} (new sessions start ${loadSettings().startup ? "on" : "off"})`,
                    ...SYSTEM_NAMES.map((name) => `  ${name}: ${settings.systems[name] ? "on" : "off"}`),
                    `key: ${keyPresent() ? "present" : "missing"} (TYPESAFE_API_KEY)`,
                    `consent: ${granted() ? "granted" : "not granted"}`,
                    `calls this session: ${state.callsUsed}/${state.callBudget}`,
                    guardStatusLine(),
                    `settings: ${settingsPath()}`,
                    `consent file: ${consentPath()}`,
                    `ledger: ${ledgerPath()}`,
                ];
                ctx.ui.notify(lines.join("\n"), "info");
            } catch (error) {
                ctx.ui.notify(safeMessage(error), "error");
            }
        },
    });
}

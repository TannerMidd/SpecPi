import fs from "node:fs";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SYSTEM_NAMES, loadSettings, saveSettings, settingsPath } from "./config.mjs";
import { keySources } from "./key-source.mjs";
import { applyLayer, layerScopeLine, layerToPersist, startupToPersist } from "./layer.mjs";
import { consentPath, granted, revokeConsent } from "./consent.mjs";
import { createBroker } from "./broker.mjs";
import { ledgerPath, read as readLedger } from "./ledger.mjs";
import { usagePath } from "./usage.mjs";
import { compact } from "./sanitize.mjs";
import * as retention from "./questions/retention.mjs";
import * as gap from "./questions/gap.mjs";
import * as sources from "./questions/sources.mjs";
import * as progress from "./questions/progress.mjs";
import * as untrusted from "./questions/untrusted.mjs";
import * as capabilities from "./questions/capabilities.mjs";

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
    let currentRequest = "";
    let taskIdentity = "";
    let taskGeneration = 0;

    const refreshObjective = async (ctx: ExtensionContext) => {
        const generation = taskGeneration;
        const replies: Promise<{ objective: string; digest: string } | undefined>[] = [];
        let contract;
        try {
            if (settings.master) {
                pi.events.emit("specpi:task-objective", {
                    ctx,
                    reply: (value: Promise<{ objective: string; digest: string } | undefined>) => replies.push(value),
                });
            }

            contract = replies.length === 1 ? await replies[0] : undefined;
        } catch {
            // A missing or unavailable workflow owner must not fail an otherwise valid tool.
        }

        if (generation !== taskGeneration) {
            return;
        }

        const next = compact(contract?.objective || currentRequest, 180);
        const identity = contract?.digest ?? currentRequest;
        if (objective !== next || taskIdentity !== identity) {
            objective = next;
            taskIdentity = identity;
            taskGeneration += 1;
            recent.length = 0;
            resetTaskHistory();
        }
    };

    // System 5's local state. Every field here is something the session already knows; it exists so
    // that "ask local state first" has something to ask. Local state cannot answer whether a session
    // is stuck, but it answers cheaply whether that question is worth 300ms and a call.
    const HISTORY_WINDOW = 12;
    const history = {
        turn: 0,
        signatures: [] as string[],
        tools: [] as string[],
        errors: [] as string[],
        consecutiveErrors: 0,
        turnsSinceChange: 0,
        filesChanged: 0,
        changedThisTurn: false,
        nudged: false,
        askedAtTurn: undefined as number | undefined,
    };
    const resetHistory = () => {
        history.turn = 0;
        history.signatures.length = 0;
        history.tools.length = 0;
        history.errors.length = 0;
        history.consecutiveErrors = 0;
        history.turnsSinceChange = 0;
        history.filesChanged = 0;
        history.changedThisTurn = false;
        history.nudged = false;
        history.askedAtTurn = undefined;
    };

    const resetTaskHistory = () => {
        const nudged = history.nudged;
        resetHistory();
        // Changing task context must not reset the existing once-per-session steering bound.
        history.nudged = nudged;
    };

    const enabled = (system: string) => settings.master && settings.systems[system] === true;

    // System 6: decide once, before the first provider request, whether this session will need a
    // withdrawn tool group -- and offer it now rather than at turn 6.
    //
    // Phase 7 is why this exists and why it is shaped like this. Flipping Browser QA on mid-session
    // collapsed cached tokens to 3,200 at the next request in three attempts out of three and cost
    // 20% of the attempt to re-warm; arming the same group from turn 1 cost 16% against 47%. The
    // whole value here is moving one decision earlier, so it happens exactly once and only before
    // the first request.
    let capabilityAsked = false;
    const capabilityDeclined = new Set<string>();

    /** Persist the session's switches, or report that it could not be done. */
    const persistLayer = (result: { settings: any }) => {
        try {
            return saveSettings(layerToPersist(result, loadSettings()));
        } catch {
            return undefined;
        }
    };

    pi.on("session_start", () => {
        settings = loadSettings();
        if (!settings.startup) {
            settings = { ...settings, master: false };
        }

        broker.reset();
        objective = "";
        currentRequest = "";
        taskGeneration += 1;
        recent.length = 0;
        resetHistory();
        capabilityAsked = false;
        capabilityDeclined.clear();
    });

    pi.on("session_shutdown", () => {
        // finish, not reset: the counts are published once more as an ended session so anything
        // reading them from outside -- SpecPi Chat's panel, most of all -- shows what the session
        // actually spent rather than a zeroed live one.
        broker.finish();
        objective = "";
        currentRequest = "";
        taskGeneration += 1;
        recent.length = 0;
        resetHistory();
    });

    pi.on("turn_start", (event: any) => {
        history.turn = typeof event?.turnIndex === "number" ? event.turnIndex : history.turn + 1;
        history.changedThisTurn = false;
    });

    // The workflow owner reads its active contract, not rendered Markdown. Without one, use only
    // the bounded current request; never recover an objective by searching stored conversations.
    pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
        currentRequest = compact(event?.prompt ?? "", 180);
        taskGeneration += 1;
        await refreshObjective(ctx);
    });
    pi.on("input", async (event: any, ctx: ExtensionContext) => {
        if (event.streamingBehavior === "steer" && event.source !== "extension") {
            currentRequest = compact(event.text ?? "", 180);
            taskGeneration += 1;
            await refreshObjective(ctx);
        }
    });
    pi.on("session_tree", () => {
        objective = "";
        currentRequest = "";
        taskGeneration += 1;
        recent.length = 0;
        resetTaskHistory();
    });

    // Once per session, whatever the answer: asking later would be the mid-session flip the probe
    // priced at three times the cost of doing it now.
    pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
        if (capabilityAsked || !enabled("capability")) {
            return;
        }

        // No interactive human means no proposal at all, exactly as `request_capability` refuses
        // without one. An unattended run must never be the thing that arms a capability.
        if (!ctx.hasUI) {
            return;
        }

        capabilityAsked = true;
        try {
            // Dynamically imported so the advisor never hard-depends on workflow-controls: a
            // core-only install fails this import and the system degrades to off rather than
            // taking the whole extension down with it.
            const table = await import("../workflow-controls/capabilities.mjs");
            const { syncActiveTools } = await import("../workflow-controls/web-access.mjs");
            const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
            const registered =
                typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool: any) => tool.name) : [];
            // Only groups that are installed and withdrawn. Proposing one that is already on, or
            // one whose package is absent, is a confirmation dialog that can only waste a person's
            // attention.
            const available = table.capabilityNames().filter((id: string) => {
                const capability = table.findCapability(id);

                return (
                    capability &&
                    table.capabilityInstalled(registered, capability) &&
                    !table.capabilityActive(active, capability)
                );
            });
            if (available.length === 0) {
                return;
            }

            let entries: string[] = [];
            try {
                entries = fs.readdirSync(ctx.cwd ?? ".").slice(0, 200);
            } catch {
                entries = [];
            }

            const local = capabilities.localSignals({ prompt: event?.prompt, entries });
            if (!local.ask) {
                return;
            }

            const generation = taskGeneration;
            await broker.request({
                system: "capability",
                isCurrent: () => generation === taskGeneration,
                profile: "capability",
                state: capabilities.buildInput({
                    prompt: event?.prompt,
                    reasons: local.reasons,
                    available,
                    cwdEntries: entries,
                }),
                questions: capabilities.questions({ available }),
                ctx,
                root: ctx.cwd,
                decide: (answers: any) => {
                    const advice = capabilities.decide(answers, available);

                    return { decision: advice };
                },
                apply: async (advice: any) => {
                    const effects: string[] = [];
                    if (advice.suggestDelegation) {
                        // A suggestion, never an activation: delegation binds a model and a host and has
                        // its own command, which is why the capability table deliberately omits it.
                        ctx.ui.notify(
                            "Jev: this looks like a question a delegated read-only session could answer over many files. Run /delegate on if you want it.",
                            "info",
                        );
                        effects.push("notification");
                    }

                    for (const id of advice.propose) {
                        const capability = table.findCapability(id);
                        if (!capability || capabilityDeclined.has(id)) {
                            continue;
                        }

                        const pending = table.missingTools(pi.getActiveTools(), capability);
                        // The same confirmation `request_capability` shows, pre-filled and moved to turn 0.
                        // Authority is unchanged: the human still decides, and declining is remembered so
                        // nothing asks twice in one session.
                        const accepted = await ctx.ui.confirm(
                            `Allow ${capability.label} for this session?`,
                            `Jev expects this request to ${capability.summary}, from the request itself rather than from anything it has done yet.\n\nThis offers ${pending.length} tool${pending.length === 1 ? "" : "s"} for the rest of this session and adds ${capability.schemaCost}. Accepting now is materially cheaper than accepting later: activating it mid-session also discards the cached prompt prefix, which measured about 20% of a mid-length attempt's cost. Withdraw it with ${capability.command} off.`,
                        );
                        effects.push("capability-proposal");
                        if (generation !== taskGeneration || !enabled("capability") || ctx.signal?.aborted) {
                            break;
                        }

                        if (!accepted) {
                            capabilityDeclined.add(id);
                            continue;
                        }

                        syncActiveTools(pi, capability.tools, true);
                        effects.push("capability-activated");
                    }

                    return { applied: effects.length > 0, effects };
                },
            });
        } catch {
            // Nothing here may prevent a session from starting.
        }
    });

    // System 1: condense a spent tool result before it is appended. Doing this after the fact would
    // rewrite a cached prefix; on arrival it never touches one.
    pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
        await refreshObjective(ctx);
        const generation = taskGeneration;
        // Bookkeeping first, and unconditionally. Retention's own eligibility gate returns early on
        // most results, and a history that only recorded the large read-only ones would be blind to
        // exactly the short repeated failures system 5 exists to notice.
        if (event?.isError === true) {
            history.consecutiveErrors += 1;
            history.errors.push(retention.resultText(event).slice(0, 200));
            if (history.errors.length > HISTORY_WINDOW) {
                history.errors.shift();
            }
        } else {
            history.consecutiveErrors = 0;
            if (progress.MUTATING_TOOLS.has(event?.toolName)) {
                history.filesChanged += 1;
                history.changedThisTurn = true;
            }
        }

        // Every result, not only the ones retention asked about. It was written in one place --
        // inside retention's success path -- so a session with retention off, or with retention's
        // budget spent, handed every other system an empty history for its whole length while
        // their question sets said history was what they weighed.
        recent.push({ tool: String(event?.toolName ?? ""), outcome: event?.isError === true ? "error" : "ok" });
        if (recent.length > MAX_RECENT) {
            recent.shift();
        }

        // Two systems share this hook. Retention wants large read-only results; system 7 wants
        // externally fetched ones whatever their size, because an injected instruction can be two
        // hundred bytes. When both want the same result they are one call: questions are evaluated
        // in parallel against one state, so the second question rides the first's digest for
        // nothing rather than paying for the same bytes twice at the same hook.
        const wantRetention = enabled("retention") && retention.eligible(event);
        const wantUntrusted = enabled("untrusted") && untrusted.applies(event);
        if (!wantRetention && !wantUntrusted) {
            return;
        }

        try {
            const text = retention.resultText(event);
            const bytes = retention.resultBytes(event);
            const result = await broker.request({
                // Charged to whichever system is driving, which is retention whenever retention is
                // interested. System 7's own budget therefore only binds when retention is off or
                // the result was too small for it.
                system: wantRetention ? "retention" : "untrusted",
                profile: wantRetention ? "retention" : "untrusted",
                isCurrent: () => generation === taskGeneration,
                state: retention.buildInput({ event, objective, recent }),
                questions: {
                    ...(wantRetention ? retention.questions() : {}),
                    ...(wantUntrusted ? untrusted.questions() : {}),
                },
                ctx,
                root: ctx.cwd,
                // The gate runs inside the call so the ledger line can say what the advice did
                // rather than only that it was asked. The replacement text is built here too,
                // because its length is the saving: computing it a second time to measure it would
                // be the measurement inventing its own number.
                decide: (answers: any) => {
                    let verdict = wantRetention ? retention.decide(answers) : { elide: false, reason: "retention-off" };
                    const flagged = wantUntrusted && untrusted.decide(answers).banner;
                    // Order matters: shorten first, then mark. A banner belongs at the top of
                    // whatever the model is actually going to read.
                    const body = verdict.elide ? retention.digest(text, { tool: event.toolName, bytes }) : text;
                    let replacement = flagged ? untrusted.mark(body) : body;
                    if (verdict.elide && Buffer.byteLength(replacement, "utf8") >= bytes) {
                        verdict = { elide: false, reason: "no-byte-saving" };
                        replacement = flagged ? untrusted.mark(text) : text;
                    }

                    const marked = flagged && replacement !== body;

                    return {
                        applied: verdict.elide || marked,
                        effects: [...(verdict.elide ? ["elision"] : []), ...(marked ? ["warning"] : [])],
                        savedBytes: verdict.elide ? bytes - Buffer.byteLength(replacement, "utf8") : 0,
                        // retention.decide already names why it declined; carrying that into the
                        // ledger is what makes "asked and did nothing" diagnosable later.
                        reason: flagged ? `${verdict.reason}+flagged` : verdict.reason,
                        decision: {
                            verdict,
                            flagged,
                            replacement: verdict.elide || flagged ? replacement : undefined,
                        },
                    };
                },
            });
            if (!result.ok) {
                return;
            }

            const { verdict, replacement } = result.decision;
            // Retention knows something the bookkeeping above does not -- whether the result was
            // spent -- so it refines its own entry rather than appending a second one for the same
            // call. If anything has been recorded since, the entry is gone and so is the chance.
            const latest = recent[recent.length - 1];
            if (wantRetention && latest?.tool === event.toolName) {
                latest.outcome = verdict.elide ? "spent" : "kept";
            }

            if (replacement === undefined) {
                return;
            }

            // Replace only the text parts. An image part carries no cheap digest and is left whole.
            const images = (event.content ?? []).filter((part: any) => part?.type !== "text");

            return { content: [{ type: "text" as const, text: replacement }, ...images] };
        } catch {
            // An advisor that throws must not fail the tool call that produced the result.
            return;
        }
    });

    pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
        history.signatures.push(progress.signature(event.toolName, event.input));
        history.tools.push(event.toolName);
        if (history.signatures.length > HISTORY_WINDOW) {
            history.signatures.shift();
        }

        if (history.tools.length > HISTORY_WINDOW) {
            history.tools.shift();
        }

        // System 4: order the sources a delegation batch will snapshot. Ordering only — the same
        // set is frozen either way, but a child pages through `list_sources` in this order.
        if (
            event.toolName === "delegate" &&
            enabled("sources") &&
            event.input?.operation === "run" &&
            Array.isArray(event.input?.packet?.jobs)
        ) {
            for (const job of event.input.packet.jobs) {
                try {
                    if (
                        !Array.isArray(job.sources) ||
                        job.sources.length < 2 ||
                        !job.sources.every((item: unknown) => typeof item === "string")
                    ) {
                        continue;
                    }

                    const original = [...job.sources];
                    const candidates = original.map((item: string) => ({ path: item }));
                    await broker.request({
                        system: "sources",
                        profile: "sources",
                        state: sources.buildInput({ question: job.question, mode: job.mode, candidates }),
                        questions: sources.questions({ candidates }),
                        ctx,
                        root: ctx.cwd,
                        decide: (answers: any) => ({ decision: sources.decide(answers, candidates) }),
                        apply: (ranked: any) => {
                            const ordered = ranked.ordered.map((item: any) => item.path);
                            const moved = ordered.some((item: string, index: number) => item !== original[index]);
                            // No deduplication: even multiplicity and ungated positions are preserved.
                            job.sources = ordered;
                            const effects = moved ? ["sources-reordered"] : [];
                            if (ranked.notWorthDelegating && ctx.hasUI) {
                                ctx.ui.notify(
                                    `Jev rates this ${job.mode} job a poor fit for delegation. Running anyway; ${ordered.length} sources remain selected.`,
                                    "warning",
                                );
                                effects.push("warning");
                            }

                            return { applied: effects.length > 0, effects };
                        },
                    });
                } catch {
                    // One unavailable job must not prevent the next job or the delegation call.
                }
            }
        }
    });

    // Wishlist owns collection and persistence. This handshake runs only after its local consent
    // gate; advisory fields never enter model-authored tool arguments or its authority decisions.
    pi.events.on("specpi:gap-triage", (request: any) => {
        if (!enabled("gap")) {
            return;
        }

        request.reply(
            (async () => {
                const existing = gap.shortlist(request.existing(), request.gap);
                let stored: any;
                let blocked = false;
                let storageError: unknown;
                const result = await broker.request({
                    system: "gap",
                    profile: "gap",
                    state: gap.buildInput({ gap: request.gap, existing }),
                    questions: gap.questions({ existing }),
                    ctx: request.ctx,
                    root: request.ctx.cwd,
                    signal: request.signal,
                    isCurrent: request.isCurrent,
                    decide: (answers: any) => ({ decision: gap.decide(answers, existing) }),
                    apply: async (advice: any) => {
                        if (advice.blockForSanitization) {
                            blocked = true;

                            return { applied: true, effects: ["report-blocked"] };
                        }

                        try {
                            stored = await request.record(advice);
                        } catch (error) {
                            storageError = error;
                            throw error;
                        }

                        return {
                            applied: stored.assessmentRecorded,
                            effects: stored.assessmentRecorded ? ["assessment-recorded"] : [],
                        };
                    },
                });
                if (storageError) {
                    throw storageError;
                }

                if (blocked) {
                    return { blocked: true };
                }

                if (["session-changed", "context-changed"].includes(result.reason)) {
                    return { cancelled: true };
                }

                return stored ? { stored } : undefined;
            })(),
        );
    });

    // System 5: notice a session that has stopped making progress, while it can still be helped.
    //
    // THE ONE HANDLER THAT IS NOT AWAITED. Everything else in this file mutates what it inspects --
    // a tool result, a tool's input -- so the session has to wait for the
    // answer. This one acts on the next turn, and at roughly 300ms a call, awaiting it on a
    // thrashing session would add seconds to an attempt to deliver advice that could not have
    // changed the turn it was asked during.
    pi.on("turn_end", (event: any, ctx: ExtensionContext) => {
        // Kept whether or not the system is on, so switching it on mid-session does not start from
        // a blank history and immediately look healthy.
        history.turnsSinceChange = history.changedThisTurn ? 0 : history.turnsSinceChange + 1;
        if (!enabled("progress") || history.nudged) {
            return;
        }

        const local = progress.suspicious(history);
        if (!local.ask) {
            return;
        }

        // Recorded before the call rather than after, so a slow answer cannot let the next turn ask
        // again while this one is still in flight.
        history.askedAtTurn = history.turn;
        const generation = taskGeneration;
        void (async () => {
            try {
                await broker.request({
                    system: "progress",
                    profile: "progress",
                    isCurrent: () => generation === taskGeneration,
                    state: progress.buildInput({ history, objective, reasons: local.reasons }),
                    questions: progress.questions(),
                    ctx,
                    root: ctx.cwd,
                    decide: (answers: any) => {
                        const advice = progress.decide(answers);

                        return {
                            reason: advice.nudge ? advice.mode : advice.stuck ? "stuck-but-mode-ungated" : "not-stuck",
                            decision: advice,
                        };
                    },
                    apply: (advice: any) => {
                        const effects = [];
                        if (!advice.nudge || history.nudged) {
                            return { applied: false };
                        }

                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                advice.needsHuman
                                    ? `Jev progress check: this session looks blocked on something only you can answer. ${advice.nudge}`
                                    : `Jev progress check: ${advice.nudge}`,
                                "warning",
                            );
                            effects.push("notification");
                        }

                        // Queue one fixed instruction, never trigger an extra turn. Queueing is
                        // observable; eventual consumption by the model is not claimed here.
                        if (
                            settings.progressNudge === "message" &&
                            !advice.needsHuman &&
                            typeof pi.sendMessage === "function"
                        ) {
                            pi.sendMessage(
                                {
                                    customType: "specpi-jev-progress",
                                    content: advice.nudge,
                                    display: true,
                                    details: { mode: advice.mode, reasons: local.reasons },
                                },
                                { deliverAs: "steer" },
                            );
                            effects.push("steering-queued");
                        }

                        history.nudged = effects.length > 0;

                        return {
                            applied: effects.length > 0,
                            effects,
                            reason: effects.length > 0 ? advice.mode : "no-delivery-channel",
                        };
                    },
                });
            } catch {
                // The turn has already ended. An advisor must not be able to fail it retroactively.
            }
        })();
    });

    pi.registerCommand("jev", {
        description: "Show or change the Jev advisor: master switch, per-system switches and the transmission ledger",
        getArgumentCompletions: (prefix: string) =>
            ["status", "on", "off", "startup", "enable", "disable", "ledger", "forget"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args: string, ctx: ExtensionContext) => {
            const [actionRaw = "status", ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw.toLowerCase();
            try {
                if (action === "on" || action === "off") {
                    const on = action === "on";
                    // `--session` is the old behaviour, kept for the case it was the right one: a
                    // one-off try that must not change what the next session does.
                    const sessionOnly = rest.some((value) => /^--?(session|once)$/u.test(value.toLowerCase()));
                    const unknown = rest.filter((value) => !/^--?(session|once)$/u.test(value.toLowerCase()));
                    if (unknown.length > 0) {
                        throw new Error(`Usage: /jev ${action} [--session]`);
                    }

                    const result = applyLayer({ on }, { settings }, { keySources: () => keySources() });
                    settings = result.settings;
                    // Persisting is the default because a switch that forgets is not a switch. The
                    // old rule -- that only /jev startup may write -- protected against a session
                    // toggle silently changing tomorrow's sessions, but the cost of that protection
                    // was a layer people turned on repeatedly and never actually ran.
                    const persisted = !sessionOnly && ctx.hasUI ? persistLayer(result) : undefined;
                    const lines = [
                        ...result.lines,
                        layerScopeLine({
                            sessionOnly,
                            interactive: ctx.hasUI,
                            persisted,
                            stored: loadSettings(),
                            settingsFile: settingsPath(),
                        }),
                    ];
                    ctx.ui.notify(lines.join("\n"), "info");

                    return;
                }

                if (action === "enable" || action === "disable") {
                    const names = rest.map((name) => name.toLowerCase());
                    const unknown = names.filter((name) => !SYSTEM_NAMES.includes(name));
                    if (names.length === 0 || unknown.length > 0) {
                        throw new Error(`Usage: /jev ${action} <${SYSTEM_NAMES.join("|")}>`);
                    }

                    const changes = Object.fromEntries(names.map((name) => [name, action === "enable"]));
                    const systems = { ...settings.systems, ...changes };
                    // Disabling the last system while the layer is on leaves it running and doing
                    // nothing -- the state `enableSystems`, `startupToPersist`, `couple` and the
                    // Chat panel's save check all exist to prevent, reachable through the one path
                    // that did not check it. Switching the layer off is the honest reading of
                    // "disable everything", and it is announced rather than inferred.
                    const emptied = settings.master && SYSTEM_NAMES.every((name) => !systems[name]);
                    settings = { ...settings, systems, master: emptied ? false : settings.master };
                    // Persisted like every other switch here, and merged into the stored map rather
                    // than overwriting it: this session's copy may predate systems enabled on disk
                    // since it started, and writing it whole turned those back off silently.
                    const kept = ctx.hasUI
                        ? (() => {
                              try {
                                  const current = loadSettings();
                                  const merged = { ...current.systems, ...changes };
                                  const dead = current.master && SYSTEM_NAMES.every((name) => !merged[name]);

                                  return saveSettings({
                                      ...current,
                                      systems: merged,
                                      master: dead ? false : current.master,
                                      startup: dead ? false : current.startup,
                                  });
                              } catch {
                                  return undefined;
                              }
                          })()
                        : undefined;
                    ctx.ui.notify(
                        `${action === "enable" ? "Enabled" : "Disabled"}: ${names.join(", ")}.` +
                            `${kept ? " Remembered for new sessions." : " This session only."}` +
                            `${emptied ? " That was the last system, so the layer was switched off; it would otherwise run and do nothing." : ""}` +
                            `${!emptied && !settings.master ? " The layer is still off; run /jev on." : ""}`,
                        "info",
                    );

                    return;
                }

                if (action === "startup") {
                    const [choice] = rest;
                    if (!choice) {
                        const current = loadSettings();
                        ctx.ui.notify(
                            `Jev starts ${current.startup && current.master ? "on" : "off"} in new sessions. Preference: ${settingsPath()}`,
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

                    // Both keys, and the systems with them. Writing `startup` alone was the whole
                    // two-keys-for-one-intention trap, left in the command named after it: the
                    // advisor's session_start keeps a stored `master` only when `startup` is true,
                    // so `startup: true, master: false` starts every future session with the layer
                    // off while this command cheerfully reported it would start on. And a layer
                    // that starts on with no system enabled runs and does nothing, so the same rule
                    // `/jev on` uses applies here: fill them in only when none are chosen.
                    const wanted = choice.toLowerCase() === "on";
                    const saved = saveSettings(startupToPersist(wanted, loadSettings()));
                    const enabled = SYSTEM_NAMES.filter((name) => saved.systems[name]);
                    ctx.ui.notify(
                        saved.startup && saved.master
                            ? `New Pi sessions will start with the Jev layer on, with ${enabled.length} of ${SYSTEM_NAMES.length} systems: ${enabled.join(", ")}. This session is unchanged; run /jev on to switch it on now.`
                            : "New Pi sessions will start with the Jev layer off. This session is unchanged.",
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

                    const lines = entries.map((entry: any) =>
                        entry.sent === false
                            ? `${entry.at} ${entry.system} local abstention: ${entry.reason}`
                            : `${entry.at} ${entry.system} ${entry.stateBytes}B ${entry.ok ? `${entry.latencyMs}ms` : entry.reason} ${String(entry.payloadSha256 ?? "").slice(0, 12)} [${(entry.questionKeys ?? []).join(", ")}]`,
                    );
                    ctx.ui.notify(`${lines.join("\n")}\n\nLedger: ${ledgerPath()}`, "info");

                    return;
                }

                if (action !== "status") {
                    throw new Error(
                        "Usage: /jev [status|on [--session]|off [--session]|startup [on|off]|enable <system>|disable <system>|ledger [n]|forget]",
                    );
                }

                const state = broker.status();
                const sources = keySources();
                const activeSource = sources.find((source: { present: boolean }) => source.present)?.name;
                const stored = loadSettings();
                const lines = [
                    `master: ${settings.master ? "on" : "off"} (new sessions start ${stored.startup && stored.master ? "on" : "off"})`,
                    ...SYSTEM_NAMES.map((name) => `  ${name}: ${settings.systems[name] ? "on" : "off"}`),
                    // Every place a key could come from, in the order they are consulted, with the
                    // one in force marked. A bare "missing" was actively misleading here: it is
                    // what someone saw who had a perfectly good OpenRouter key stored by /login,
                    // and it gave them nothing to act on. Names only -- no key is ever printed.
                    `key: ${activeSource ? `in use from ${activeSource}` : "none found"}`,
                    ...sources.map(
                        (source: { name: string; label: string; detail: string; present: boolean }) =>
                            `  ${source.present ? "found" : "   - "} ${source.label} (${source.detail})`,
                    ),
                    `consent: ${granted() ? "granted" : "not granted"}`,
                    `calls this session: ${state.callsUsed}/${state.budgets.total} total`,
                    ...SYSTEM_NAMES.map((name) => `  ${name}: ${state.usedBySystem[name] ?? 0}/${state.budgets[name]}`),
                    `settings: ${settingsPath()}`,
                    `consent file: ${consentPath()}`,
                    `ledger: ${ledgerPath()}`,
                    // Named here because it is the one file another process is meant to read, and
                    // SpecPi Chat showing a number nobody can find is how a number stops being
                    // checkable.
                    `session counts: ${usagePath()}`,
                ];
                ctx.ui.notify(lines.join("\n"), "info");
            } catch (error) {
                ctx.ui.notify(safeMessage(error), "error");
            }
        },
    });
}

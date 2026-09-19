import fs from "node:fs";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SYSTEM_NAMES, keySource, keySources, loadSettings, saveSettings, settingsPath } from "./config.mjs";
import { backend, keyEnvName } from "./client.mjs";
import { consentPath, granted, revokeConsent } from "./consent.mjs";
import { createBroker } from "./broker.mjs";
import { ledgerPath, read as readLedger } from "./ledger.mjs";
import { usagePath } from "./usage.mjs";
import {
    FALLBACK_PACKAGE,
    applyConfig as applyGuardConfig,
    installed as installedGuard,
    statusLine as guardStatusLine,
} from "./guard.mjs";
import * as retention from "./questions/retention.mjs";
import * as compaction from "./questions/compaction.mjs";
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

    /**
     * Turn the whole layer on or off, and say what actually happened.
     *
     * "On" used to mean the master switch alone, which left all seven systems off and the layer
     * doing nothing at all -- the notification even said so, and then asked for seven more commands.
     * A switch labelled on that produces no behaviour is not a safe default, it is a broken one, so
     * enabling the layer now enables its systems too.
     *
     * It only fills in systems when none are on. A person who deliberately runs retention alone has
     * expressed a preference, and `/jev off` followed by `/jev on` must not quietly hand back the
     * six they turned off.
     */
    const setLayer = (on: boolean) => {
        const lines: string[] = [];
        if (!on) {
            settings = { ...settings, master: false };
            guardEnabled = false;
            syncGuard();
            lines.push(
                "Jev layer off. No state leaves this machine, and every tool call goes to the permission system.",
            );

            return { lines };
        }

        const alreadyOn = SYSTEM_NAMES.filter((name) => settings.systems[name]);
        const systems =
            alreadyOn.length > 0 ? settings.systems : Object.fromEntries(SYSTEM_NAMES.map((name) => [name, true]));
        settings = { ...settings, master: true, systems };
        const active = SYSTEM_NAMES.filter((name) => settings.systems[name]);
        lines.push(`Jev layer on with ${active.length} of ${SYSTEM_NAMES.length} systems: ${active.join(", ")}.`);
        if (alreadyOn.length === 0) {
            lines.push("No system was enabled, so all of them were. Turn any back off with /jev disable <system>.");
        }

        lines.push(keyLine());
        lines.push(...armGuard());

        return { lines };
    };

    /**
     * One line saying where the key is coming from, by name and never by value.
     *
     * "key: missing" was the whole of this report before, and it was wrong often enough to matter:
     * a key sitting in Pi's own credential store read as missing, because the layer looked only at
     * the environment. Naming the source is what makes the answer checkable.
     */
    const keyLine = () => {
        const source = keySource(backend());
        if (source) {
            return `Key: found in ${source === "auth.json" ? "Pi's credential store (auth.json)" : source}.`;
        }

        return (
            "Key: none found, so every system will report no advice and the harness runs exactly as it did before. " +
            "Run /login openrouter to store one, or set OPENROUTER_API_KEY."
        );
    };

    /**
     * The command guard, switched with the rest of the layer rather than on its own.
     *
     * Two things make it unlike the seven advisor systems, and both are handled here rather than
     * left to be discovered. It is fail-closed: with no key it blocks shell and file calls instead
     * of standing aside, so turning it on without one would hand someone a session that refuses to
     * run commands. And it reads its key from the environment only -- it is a separate package with
     * no knowledge of Pi's credential store -- so a key that serves the advisor perfectly well may
     * be invisible to it.
     *
     * The tempting fix is to copy the resolved key into `process.env` so the guard can see it. That
     * is refused deliberately: the environment is inherited by every command the agent runs, so it
     * would turn a credential scoped to one file into one that any `env` in a shell tool can read.
     * Enabling a security feature is not a reason to widen the blast radius of a secret. The guard
     * stays off instead, and says which variable would change that.
     */
    const armGuard = () => {
        if (!installedGuard().installed) {
            return [`Command guard: not installed, so command policy stays with ${FALLBACK_PACKAGE}.`];
        }

        const variable = keyEnvName(backend());
        if (!process.env[variable]?.trim()) {
            const stored = keySource(backend());

            return [
                `Command guard: left off. It reads ${variable} from the environment and cannot see ` +
                    `${stored === "auth.json" ? "the key in Pi's credential store" : "any key"}, and it fails closed -- ` +
                    "switching it on without a key it can read would block every shell and file call. " +
                    `Set ${variable} in the environment, then /jev guard on.`,
            ];
        }

        guardEnabled = true;
        const result = syncGuard();

        return [
            result.applied || result.reason === "already-current"
                ? "Command guard: ON. It scores shell and file calls before the permission system sees them, and blocks them while Jev is unreachable. /jev guard off returns policy to the permission system."
                : "Command guard: could not be switched on; its settings file is not writable. Command policy stays with the permission system.",
        ];
    };

    /**
     * Write the layer's switches back to the preference file, so turning it on is remembered.
     *
     * `master` and `startup` are always written together. Storing them apart is what made the Chat
     * panel's "enabled" checkbox do nothing on its own: `session_start` zeroes a stored master
     * whenever `startup` is false, so a file saying `master: true, startup: false` describes a layer
     * that is on and never runs. Two switches for one intention, one of which silently cancels the
     * other, is a trap rather than a setting.
     *
     * The stored file is the base rather than the session's own copy, so budgets or a nudge mode
     * written by Chat while this session was running survive being switched on and off here.
     */
    const persistLayer = () => {
        try {
            return saveSettings({
                ...loadSettings(),
                master: settings.master,
                startup: settings.master,
                systems: { ...settings.systems },
                guard: { enabled: guardEnabled, startup: guardEnabled },
            });
        } catch {
            return undefined;
        }
    };

    /** What the change just done applies to: this session, or every session from now on. */
    const layerScopeLine = (
        sessionOnly: boolean,
        ctx: ExtensionContext,
        persisted: ReturnType<typeof persistLayer>,
    ) => {
        if (sessionOnly) {
            return `This session only, as asked. New sessions still start ${loadSettings().startup ? "on" : "off"}.`;
        }

        if (!ctx.hasUI) {
            return "This session only: writing the startup preference needs an interactive command.";
        }

        if (!persisted) {
            return `This session only: ${settingsPath()} could not be written.`;
        }

        return `Remembered -- new Pi sessions start this way too. Preference: ${settingsPath()}`;
    };

    pi.on("session_start", () => {
        settings = loadSettings();
        if (!settings.startup) {
            settings = { ...settings, master: false };
        }

        broker.reset();
        recent.length = 0;
        resetHistory();
        capabilityAsked = false;
        capabilityDeclined.clear();
        guardEnabled = settings.guard.startup === true;
        // Deliberately outside the master switch. The guard is a separate package with its own
        // gate, and whether it is inert is a property of the install rather than a feature of the
        // advisor, so its configuration is rewritten every session either way. Off is the default
        // and is a real written configuration, not an absence of one.
        syncGuard();
    });

    pi.on("session_shutdown", () => {
        // finish, not reset: the counts are published once more as an ended session so anything
        // reading them from outside -- SpecPi Chat's panel, most of all -- shows what the session
        // actually spent rather than a zeroed live one.
        broker.finish();
        recent.length = 0;
        resetHistory();
    });

    pi.on("turn_start", (event: any) => {
        history.turn = typeof event?.turnIndex === "number" ? event.turnIndex : history.turn + 1;
        history.changedThisTurn = false;
    });

    // The task objective is the one piece of context every system wants, and it is already in the
    // system prompt, so reading it here costs nothing extra.
    pi.on("before_agent_start", (event: any) => {
        const match = /\[SPECPI TASK CONTRACT\]\n([^\n]{0,200})/u.exec(event?.systemPrompt ?? "");
        if (match) {
            objective = match[1];
        }
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

            const result = await broker.request({
                system: "capability",
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

                    return { applied: advice.propose.length > 0, decision: advice };
                },
            });
            if (!result.ok) {
                return;
            }

            const advice = result.decision;
            if (advice.suggestDelegation) {
                // A suggestion, never an activation: delegation binds a model and a host and has
                // its own command, which is why the capability table deliberately omits it.
                ctx.ui.notify(
                    "Jev: this looks like a question a delegated read-only session could answer over many files. Run /delegate on if you want it.",
                    "info",
                );
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
                if (!accepted) {
                    capabilityDeclined.add(id);
                    continue;
                }

                syncActiveTools(pi, capability.tools, true);
            }
        } catch {
            // Nothing here may prevent a session from starting.
        }
    });

    // System 1: condense a spent tool result before it is appended. Doing this after the fact would
    // rewrite a cached prefix; on arrival it never touches one.
    pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
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
                    const verdict = wantRetention
                        ? retention.decide(answers)
                        : { elide: false, reason: "retention-off" };
                    const flagged = wantUntrusted && untrusted.decide(answers).banner;
                    // Order matters: shorten first, then mark. A banner belongs at the top of
                    // whatever the model is actually going to read.
                    const body = verdict.elide ? retention.digest(text, { tool: event.toolName, bytes }) : text;
                    const replacement = flagged ? untrusted.mark(body) : body;

                    return {
                        applied: verdict.elide || flagged,
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
            if (wantRetention) {
                recent.push({ tool: event.toolName, outcome: verdict.elide ? "spent" : "kept" });
                if (recent.length > MAX_RECENT) {
                    recent.shift();
                }
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
                decide: (answers: any) => {
                    const built = compaction.decide(answers);

                    // Nothing is shortened here, so savedBytes stays 0 and `applied` is the whole
                    // record: either a sentence reached the summariser or Pi's own prompt ran.
                    return { applied: Boolean(built.customInstructions), decision: built };
                },
            });
            if (!result.ok) {
                return;
            }

            const advice = result.decision;
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

    // System 1b, second hook. Branch summarisation is the same problem at the same boundary --
    // something is about to be reduced to a summary and the prefix is being rebuilt regardless --
    // and it was simply unserved. It shares the compaction switch rather than adding a fifth
    // system, because a user who has decided the advisor may steer a summary has decided that once.
    //
    // `label` is the part worth having. Pi's `/tree` can filter to labelled entries, so a branch
    // that says what it was is the difference between a navigable tree and a list of timestamps,
    // and the enum is fixed so no model-written text reaches the session file.
    pi.on("session_before_tree", async (event: any, ctx: ExtensionContext) => {
        if (!enabled("compaction")) {
            return;
        }

        try {
            const entries = event?.preparation?.entriesToSummarize ?? [];
            if (entries.length === 0) {
                return;
            }

            const result = await broker.request({
                system: "compaction",
                state: compaction.buildBranchInput({ preparation: event.preparation, objective }),
                questions: compaction.questions({ branch: true }),
                ctx,
                root: ctx.cwd,
                signal: event.signal,
                decide: (answers: any) => {
                    const built = compaction.decide(answers);
                    const branchLabel = compaction.label(answers);

                    return {
                        applied: Boolean(branchLabel || built.customInstructions),
                        decision: { ...built, label: branchLabel },
                    };
                },
            });
            if (!result.ok) {
                return;
            }

            const advice = result.decision;
            const patch: Record<string, unknown> = {};
            if (advice.label) {
                patch.label = advice.label;
            }

            // Only when a summary is actually going to be generated. Instructions for a summariser
            // that will not run are bytes nobody reads, and `replaceInstructions` is left alone so
            // Pi's own branch prompt still frames the result.
            if (advice.customInstructions && event.preparation?.userWantsSummary === true) {
                const existing =
                    typeof event.preparation?.customInstructions === "string"
                        ? event.preparation.customInstructions.trim()
                        : "";
                patch.customInstructions = existing
                    ? `${existing}\n\n${advice.customInstructions}`
                    : advice.customInstructions;
            }

            return Object.keys(patch).length > 0 ? patch : undefined;
        } catch {
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
                    decide: (answers: any) => {
                        const built = gap.decide(answers);
                        // Exactly the conditions the caller applies below, so the ledger line says
                        // what happened rather than what was available. A gated answer that
                        // duplicates a field the model already filled in changed nothing.
                        const changes =
                            (built.blockForSanitization ? 1 : 0) +
                            (built.canonicalKey && typeof event.input?.canonicalKey !== "string" ? 1 : 0) +
                            (built.suggestedFix && !event.input?.suggestedFix ? 1 : 0) +
                            (built.independentImpact ? 1 : 0);

                        return { applied: changes > 0, decision: built };
                    },
                });
                if (!result.ok) {
                    return;
                }

                const advice = result.decision;
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
                    decide: (answers: any) => {
                        const built = sources.decide(answers, candidates);
                        const order = built.ordered.map((item: any) => item.path);
                        // An ungated run returns the caller's own order, which is not a change and
                        // must not be recorded as one.
                        const moved = order.some((item: string, index: number) => item !== candidates[index]?.path);

                        return { applied: moved, decision: { ranked: built, ordered: order } };
                    },
                });
                if (!result.ok) {
                    return;
                }

                const { ranked, ordered } = result.decision;
                const missing = event.input.sources.filter((item: string) => !ordered.includes(item));
                event.input.sources = [...ordered, ...missing];

                // Two answers the same batch already computed and nothing read. Output is free, so
                // they were paid for whether or not anyone looked. A confident "this is not a
                // self-contained evidence question" is worth surfacing before specpi-delegation
                // freezes up to 200 files and 8 MiB for a child that then cannot answer it.
                //
                // Advisory only, and deliberately so: the batch still runs, the ceilings are
                // unchanged, and with no UI this says nothing rather than blocking.
                if (ranked.notWorthDelegating && ctx.hasUI) {
                    ctx.ui.notify(
                        `Jev rates this a poor fit for delegation${ranked.jobMode ? ` (it reads as ${ranked.jobMode} work)` : ""}. Running anyway; ${ordered.length + missing.length} sources will be frozen for the child.`,
                        "warning",
                    );
                }
            } catch {
                return;
            }
        }
    });

    // System 5: notice a session that has stopped making progress, while it can still be helped.
    //
    // THE ONE HANDLER THAT IS NOT AWAITED. Everything else in this file mutates what it inspects --
    // a tool result, a compaction patch, a tool's input -- so the session has to wait for the
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
        void (async () => {
            try {
                const result = await broker.request({
                    system: "progress",
                    state: progress.buildInput({ history, objective, reasons: local.reasons }),
                    questions: progress.questions(),
                    ctx,
                    root: ctx.cwd,
                    decide: (answers: any) => {
                        const advice = progress.decide(answers);

                        return {
                            applied: Boolean(advice.nudge),
                            reason: advice.nudge ? advice.mode : advice.stuck ? "stuck-but-mode-ungated" : "not-stuck",
                            decision: advice,
                        };
                    },
                });
                if (!result.ok || !result.decision?.nudge) {
                    return;
                }

                // Write-once, per the standing rule. A second nudge would either repeat a line the
                // model already has or contradict it, and neither can be withdrawn: it was appended
                // to a prefix that is cached behind it by the time anyone regrets it.
                history.nudged = true;
                if (ctx.hasUI) {
                    ctx.ui.notify(
                        result.decision.needsHuman
                            ? `Jev progress check: this session looks blocked on something only you can answer. ${result.decision.nudge}`
                            : `Jev progress check: ${result.decision.nudge}`,
                        "warning",
                    );
                }

                // The plan specified `deliverAs: "nextTurn"`, which is documented as "queued for
                // next user prompt, does not interrupt or trigger anything". An unattended session
                // has exactly one user prompt, so a nextTurn message would never be delivered -- in
                // precisely the case the argument for this system rests on, a headless attempt
                // burning its wall clock. "steer" is delivered after the current tool calls finish
                // and before the next model request, which is the same append at the same boundary
                // and is actually read. triggerTurn is left off so this can never add a turn.
                // Suppressed when the session is blocked on something only a person can answer:
                // steering a model past a missing credential costs a turn to say nothing.
                if (
                    settings.progressNudge === "message" &&
                    !result.decision.needsHuman &&
                    typeof pi.sendMessage === "function"
                ) {
                    pi.sendMessage(
                        {
                            customType: "specpi-jev-progress",
                            content: result.decision.nudge,
                            display: true,
                            details: { mode: result.decision.mode, reasons: local.reasons },
                        },
                        { deliverAs: "steer" },
                    );
                }
            } catch {
                // The turn has already ended. An advisor must not be able to fail it retroactively.
            }
        })();
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
                    const on = action === "on";
                    // `--session` is the old behaviour, kept for the case it was the right one: a
                    // one-off try that must not change what the next session does.
                    const sessionOnly = rest.some((value) => /^--?(session|once)$/u.test(value.toLowerCase()));
                    const unknown = rest.filter((value) => !/^--?(session|once)$/u.test(value.toLowerCase()));
                    if (unknown.length > 0) {
                        throw new Error(`Usage: /jev ${action} [--session]`);
                    }

                    const result = setLayer(on);
                    // Persisting is the default because a switch that forgets is not a switch. The
                    // old rule -- that only /jev startup may write -- protected against a session
                    // toggle silently changing tomorrow's sessions, but the cost of that protection
                    // was a layer people turned on repeatedly and never actually ran.
                    const persisted = !sessionOnly && ctx.hasUI ? persistLayer() : undefined;
                    const lines = [...result.lines, layerScopeLine(sessionOnly, ctx, persisted)];
                    ctx.ui.notify(lines.join("\n"), "info");

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
                        "Usage: /jev [status|on [--session]|off [--session]|startup [on|off]|enable <system>|disable <system>|guard [on|off|startup [on|off]]|ledger [n]|forget]",
                    );
                }

                const state = broker.status();
                const lines = [
                    `master: ${settings.master ? "on" : "off"} (new sessions start ${loadSettings().startup ? "on" : "off"})`,
                    ...SYSTEM_NAMES.map((name) => `  ${name}: ${settings.systems[name] ? "on" : "off"}`),
                    // Every place a key could come from, in the order they are consulted, with the
                    // one in force marked. A bare "missing" was actively misleading here: it is
                    // what someone saw who had a perfectly good OpenRouter key stored by /login,
                    // and it gave them nothing to act on. Names only -- no key is ever printed.
                    `key: ${keySource(backend()) ? `in use from ${keySource(backend())}` : "none found"}`,
                    ...keySources(backend()).map(
                        (source: { name: string; label: string; detail: string; present: boolean }) =>
                            `  ${source.present ? "found" : "   - "} ${source.label} (${source.detail})`,
                    ),
                    `consent: ${granted() ? "granted" : "not granted"}`,
                    `calls this session: ${state.callsUsed}/${state.budgets.total} total`,
                    ...SYSTEM_NAMES.map((name) => `  ${name}: ${state.usedBySystem[name] ?? 0}/${state.budgets[name]}`),
                    guardStatusLine(),
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

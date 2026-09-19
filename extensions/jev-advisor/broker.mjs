// The only thing in this extension that touches the network. Systems are questions plus a gate;
// they never hold a client, so two systems firing at one hook cost one call rather than two.
//
// Every gate is checked here, in one order, before anything leaves the process: master switch,
// per-system switch, human consent, per-system budget, session total budget, then the byte budget
// inside sanitize.
//
// AWAIT ONLY THE SYSTEMS THAT MUTATE WHAT THEY INSPECT. Retention must be awaited, because its
// answer replaces the tool result it was asked about; so must compaction, the branch hook and the
// two tool_call systems, which return a patch or edit `event.input` in place. A system that acts on
// a later turn must not be awaited: at roughly 300ms a call, a turn-level system firing thirty
// times would add nine seconds to an attempt that takes a hundred and thirty, to deliver advice
// that was never going to change the turn it was asked during.

import { randomUUID } from "node:crypto";
import { SYSTEM_NAMES, loadSettings } from "./config.mjs";
import { ensureConsent } from "./consent.mjs";
import { buildState } from "./sanitize.mjs";
import { ask } from "./client.mjs";
import { payloadDigest, record } from "./ledger.mjs";
import { writeUsage } from "./usage.mjs";

export const SYSTEM_LABELS = Object.freeze({
    retention: "Tool-result retention",
    compaction: "Compaction guidance",
    gap: "Capability-gap triage",
    sources: "Delegation source ranking",
    progress: "Progress and thrash detection",
    untrusted: "Untrusted-content classification",
    capability: "Turn-zero capability arming",
    guard: "Command guard",
});

export function createBroker(options = {}) {
    // Injected in tests so master-off can be proven as "the transport was never reached" rather
    // than "no socket was observed".
    const transport = options.ask ?? ask;
    const readSettings = options.loadSettings ?? loadSettings;
    const resolveConsent = options.ensureConsent ?? ensureConsent;
    const write = options.record ?? record;
    // Separate from `record` because it answers a different question and is read by a different
    // reader. The ledger is an audit trail for a person; this is a live counter for SpecPi Chat,
    // which runs in another process and cannot see `callsUsed`.
    const publish = options.recordUsage ?? writeUsage;

    let callsUsed = 0;
    let generation = 0;
    let session = "";
    let startedAt = "";
    const usedBySystem = new Map();
    const effects = new Map();
    const warned = new Set();

    /** Zero counts for every system, so a reader never has to distinguish absent from unused. */
    const snapshot = (active) => {
        const settings = readSettings();

        return {
            schema: 1,
            session,
            startedAt,
            updatedAt: new Date().toISOString(),
            active,
            calls: callsUsed,
            budgets: settings.budgets,
            systems: Object.fromEntries(
                SYSTEM_NAMES.map((name) => [
                    name,
                    {
                        calls: usedBySystem.get(name) ?? 0,
                        applied: effects.get(name)?.applied ?? 0,
                        failed: effects.get(name)?.failed ?? 0,
                        savedBytes: effects.get(name)?.savedBytes ?? 0,
                    },
                ]),
            ),
        };
    };

    const clear = () => {
        callsUsed = 0;
        usedBySystem.clear();
        effects.clear();
        warned.clear();
        // Bumped before anything else so an answer still in flight from the previous session is
        // discarded rather than counted against the new one.
        generation += 1;
    };

    /**
     * Publishing is itself gated on the master switch. With the layer off this extension is meant
     * to leave no trace at all, and a counts file appearing in every Pi session on every machine
     * that merely has SpecPi installed is a trace. Once a call has been made there is something
     * worth saying, so the count keeps being published for the rest of the session even if the
     * master switch is turned back off.
     */
    const publishIf = (active) => {
        if (callsUsed > 0 || readSettings().master === true) {
            publish(snapshot(active));
        }
    };

    const reset = () => {
        clear();
        session = randomUUID();
        startedAt = new Date().toISOString();
        publishIf(true);
    };

    /**
     * End of session. The counts are published one last time with `active` false rather than
     * cleared, because a reader that found no file could not tell "this layer has never run" from
     * "the session that just ended spent its whole budget", and the second is the more useful
     * thing to be able to see after the fact.
     */
    const finish = () => {
        publishIf(false);
        clear();
    };

    /**
     * Running out of budget used to be indistinguishable from a system that had nothing to say.
     * Both produce silence, and silence is this layer's normal state, so a session could spend an
     * hour with retention switched on and quietly dead without anything ever saying so. The notice
     * fires once per system per session -- repeating it every turn would be its own nuisance -- and
     * only where there is a human to read it.
     */
    const warnExhausted = (system, ctx, scope) => {
        if (warned.has(system) || !ctx?.hasUI || typeof ctx?.ui?.notify !== "function") {
            return;
        }

        warned.add(system);
        try {
            ctx.ui.notify(
                scope === "system"
                    ? `Jev: the ${SYSTEM_LABELS[system] ?? system} budget for this session is spent, so that system is now off until the session ends. Raise it in SpecPi Chat under package settings, or in the Jev layer's own settings file.`
                    : `Jev: this session's total call budget is spent, so the whole advisor is now quiet until the session ends. Raise it in SpecPi Chat under package settings, or in the Jev layer's own settings file.`,
                "info",
            );
        } catch {
            // A notice that cannot be delivered must not fail the call it was reporting on.
        }
    };

    const status = () => {
        const settings = readSettings();

        return {
            master: settings.master,
            systems: settings.systems,
            session,
            callsUsed,
            budgets: settings.budgets,
            usedBySystem: Object.fromEntries(usedBySystem),
        };
    };

    /**
     * Ask one batch for one system. Returns `{ ok: false, reason }` for every refusal so a caller
     * can log why it got no advice without having to distinguish "switched off" from "timed out".
     *
     * `decide` is how the ledger learns what the advice did. The ledger recorded bytes sent and
     * never whether the answer was taken, so a system's effect could only be inferred from a cost
     * delta it may not have caused. The callback runs here, before the ledger write, because that
     * is the only point where the answers and the audit line exist together; its `decision` is
     * handed back so the caller does not gate the same answers twice.
     */
    const request = async ({ system, state, questions, ctx, root, maxBytes, timeoutMs, signal, decide }) => {
        const settings = readSettings();
        if (!settings.master) {
            return { ok: false, reason: "master-off", answers: {} };
        }

        if (settings.systems[system] !== true) {
            return { ok: false, reason: "system-off", answers: {} };
        }

        // Per-system first, so an exhausted turn-level system reports its own exhaustion rather
        // than looking like the session as a whole ran out.
        if ((usedBySystem.get(system) ?? 0) >= (settings.budgets?.[system] ?? 0)) {
            warnExhausted(system, ctx, "system");

            return { ok: false, reason: "system-budget-exhausted", answers: {} };
        }

        if (callsUsed >= (settings.budgets?.total ?? 0)) {
            warnExhausted("total", ctx, "total");

            return { ok: false, reason: "budget-exhausted", answers: {} };
        }

        const consented = await resolveConsent(ctx, SYSTEM_LABELS[system] ?? system);
        if (!consented) {
            return { ok: false, reason: "no-consent", answers: {} };
        }

        // Settings can change while the dialog is open, and a session can end under it.
        const current = readSettings();
        if (!current.master || current.systems[system] !== true) {
            return { ok: false, reason: "master-off", answers: {} };
        }

        const built = buildState(state, { root, maxBytes });
        const questionKeys = Object.keys(questions);
        callsUsed += 1;
        usedBySystem.set(system, (usedBySystem.get(system) ?? 0) + 1);
        const startedGeneration = generation;
        const result = await transport(built.state, questions, { timeoutMs, signal });
        // The session can end under a call that was never awaited, which is the normal shape of a
        // turn-level system: the payload has already left the machine, and the answer now belongs
        // to a session that no longer exists. It must not be acted on. It must still be recorded --
        // the ledger's whole claim is that every transmission appears in it, and a run that sent 44
        // and logged 43 is how this was found. So the line is written either way and says which.
        const stale = startedGeneration !== generation;

        // A gate that throws must not turn into a failed call: the caller's own catch would have
        // swallowed it anyway, and recording it as unapplied is the truthful line.
        let outcome = { applied: false };
        if (!stale && result.ok && typeof decide === "function") {
            try {
                outcome = decide(result.answers) ?? { applied: false };
            } catch {
                outcome = { applied: false, gateThrew: true };
            }
        }

        write({
            system,
            questionKeys,
            stateBytes: built.bytes,
            stateTruncated: built.truncated,
            payloadSha256: payloadDigest({ state: built.state, questions }),
            ok: result.ok,
            reason: result.ok ? undefined : result.reason,
            // A sent payload whose answer arrived too late to use. Distinguished from a refusal,
            // because nothing was refused: it was asked, answered, and discarded.
            discarded: stale ? true : undefined,
            // Whether the advice changed anything, and what it saved when the change was a
            // shortening. Zero is a real answer here and means "asked, and kept the result whole".
            applied: outcome.applied === true,
            // And why not, when nothing changed. Without this a system that asks and never acts is
            // indistinguishable from one whose gate can never be satisfied, which is the exact
            // failure the calibration pass had to go looking for by hand.
            outcome: stale ? "session-changed" : typeof outcome.reason === "string" ? outcome.reason : undefined,
            savedBytes: Number.isFinite(outcome.savedBytes) ? Math.max(0, Math.round(outcome.savedBytes)) : 0,
            gateThrew: outcome.gateThrew === true ? true : undefined,
            latencyMs: result.latencyMs,
            model: result.model,
            // Values only, never the state that produced them: enough to plot a calibration curve.
            answers: Object.fromEntries(
                Object.entries(result.answers ?? {}).map(([name, answer]) => [
                    name,
                    { kind: answer.kind, value: answer.value, confidence: answer.confidence },
                ]),
            ),
        });

        if (stale) {
            // Counted against the session it was made in, which has already been published and
            // cleared. Adding it to the new session's running total would attribute one session's
            // spend to the next one.
            return { ok: false, reason: "session-changed", answers: {} };
        }

        const effect = effects.get(system) ?? { applied: 0, failed: 0, savedBytes: 0 };
        effect.applied += outcome.applied === true ? 1 : 0;
        effect.failed += result.ok ? 0 : 1;
        effect.savedBytes += Number.isFinite(outcome.savedBytes) ? Math.max(0, Math.round(outcome.savedBytes)) : 0;
        effects.set(system, effect);
        publishIf(true);

        return { ...result, decision: outcome.decision };
    };

    return { request, reset, finish, status };
}

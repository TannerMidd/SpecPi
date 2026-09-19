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

import { loadSettings } from "./config.mjs";
import { ensureConsent } from "./consent.mjs";
import { buildState } from "./sanitize.mjs";
import { ask } from "./client.mjs";
import { payloadDigest, record } from "./ledger.mjs";

export const SYSTEM_LABELS = Object.freeze({
    retention: "Tool-result retention",
    compaction: "Compaction guidance",
    gap: "Capability-gap triage",
    sources: "Delegation source ranking",
    progress: "Progress and thrash detection",
    untrusted: "Untrusted-content classification",
    capability: "Turn-zero capability arming",
});

export function createBroker(options = {}) {
    // Injected in tests so master-off can be proven as "the transport was never reached" rather
    // than "no socket was observed".
    const transport = options.ask ?? ask;
    const readSettings = options.loadSettings ?? loadSettings;
    const resolveConsent = options.ensureConsent ?? ensureConsent;
    const write = options.record ?? record;

    let callsUsed = 0;
    let generation = 0;
    const usedBySystem = new Map();

    const reset = () => {
        callsUsed = 0;
        usedBySystem.clear();
        generation += 1;
    };

    const status = () => {
        const settings = readSettings();

        return {
            master: settings.master,
            systems: settings.systems,
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
            return { ok: false, reason: "system-budget-exhausted", answers: {} };
        }

        if (callsUsed >= (settings.budgets?.total ?? 0)) {
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
        if (startedGeneration !== generation) {
            return { ok: false, reason: "session-changed", answers: {} };
        }

        // A gate that throws must not turn into a failed call: the caller's own catch would have
        // swallowed it anyway, and recording it as unapplied is the truthful line.
        let outcome = { applied: false };
        if (result.ok && typeof decide === "function") {
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
            // Whether the advice changed anything, and what it saved when the change was a
            // shortening. Zero is a real answer here and means "asked, and kept the result whole".
            applied: outcome.applied === true,
            // And why not, when nothing changed. Without this a system that asks and never acts is
            // indistinguishable from one whose gate can never be satisfied, which is the exact
            // failure the calibration pass had to go looking for by hand.
            outcome: typeof outcome.reason === "string" ? outcome.reason : undefined,
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

        return { ...result, decision: outcome.decision };
    };

    return { request, reset, status };
}

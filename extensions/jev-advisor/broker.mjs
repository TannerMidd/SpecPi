// The only thing in this extension that touches the network. Systems are questions plus a gate;
// they never hold a client, so two systems firing at one hook cost one call rather than two.
//
// Every gate is checked here, in one order, before anything leaves the process: master switch,
// per-system switch, human consent, session call budget, then the byte budget inside sanitize.

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

    const reset = () => {
        callsUsed = 0;
        generation += 1;
    };

    const status = () => {
        const settings = readSettings();

        return {
            master: settings.master,
            systems: settings.systems,
            callsUsed,
            callBudget: settings.callBudgetPerSession,
        };
    };

    /**
     * Ask one batch for one system. Returns `{ ok: false, reason }` for every refusal so a caller
     * can log why it got no advice without having to distinguish "switched off" from "timed out".
     */
    const request = async ({ system, state, questions, ctx, root, maxBytes, timeoutMs, signal }) => {
        const settings = readSettings();
        if (!settings.master) {
            return { ok: false, reason: "master-off", answers: {} };
        }

        if (settings.systems[system] !== true) {
            return { ok: false, reason: "system-off", answers: {} };
        }

        if (settings.callBudgetPerSession > 0 && callsUsed >= settings.callBudgetPerSession) {
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
        const startedGeneration = generation;
        const result = await transport(built.state, questions, { timeoutMs, signal });
        if (startedGeneration !== generation) {
            return { ok: false, reason: "session-changed", answers: {} };
        }

        write({
            system,
            questionKeys,
            stateBytes: built.bytes,
            stateTruncated: built.truncated,
            payloadSha256: payloadDigest({ state: built.state, questions }),
            ok: result.ok,
            reason: result.ok ? undefined : result.reason,
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

        return result;
    };

    return { request, reset, status };
}

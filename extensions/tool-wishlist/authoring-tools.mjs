// Phase 0 of the Jev advisor plan, which needs no model at all.
//
// Measured across the recorded eval runs, six of SpecPi's ten offered tools were offered on 31 of
// 31 attempts and called zero times. Two of them are these: `record_harness_contract` and
// `finish_harness_improvement` are *authoring* tools, usable only after a human has selected a
// candidate through /harness-improvement. Whether a selection exists is a fact in local state, so
// the answer is a boolean — no latency, no cost, no false positives, and nothing for a classifier
// to route.
//
// `report_capability_gap` is deliberately not in this list. It is the *observation* tool and the
// reason the improvement loop exists; withdrawing it would silently lose the friction reports the
// loop is built to capture. It stays offered at all times.

/** Only usable while an improvement is selected. */
export const AUTHORING_TOOL_NAMES = Object.freeze(["record_harness_contract", "finish_harness_improvement"]);

/**
 * Add or remove the authoring tools without disturbing any other extension's tools. Mirrors the
 * web-access gate: it only ever touches the names it owns, and it does nothing when the active set
 * already matches, so a no-op never costs the cached prompt prefix.
 */
export function syncAuthoringTools(pi, selected) {
    if (typeof pi?.getActiveTools !== "function" || typeof pi?.setActiveTools !== "function") {
        return false;
    }

    const owned = new Set(AUTHORING_TOOL_NAMES);
    const active = pi.getActiveTools();
    const present = active.filter((name) => owned.has(name));
    if (selected && present.length === owned.size) {
        return false;
    }

    if (!selected && present.length === 0) {
        return false;
    }

    const others = active.filter((name) => !owned.has(name));
    pi.setActiveTools(selected ? [...others, ...AUTHORING_TOOL_NAMES] : others);

    return true;
}

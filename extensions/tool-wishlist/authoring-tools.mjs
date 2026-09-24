// Phase 0 of the Jev advisor plan, which needs no model at all.
//
// Measured across the recorded eval runs, six of SpecPi's ten offered tools were offered on 31 of
// 31 attempts and called zero times. Two of them are these: `record_harness_contract` and
// `finish_harness_improvement` are *authoring* tools, usable only after a human has selected a
// candidate through /harness-improvement. Whether a selection exists is a fact in local state, so
// the answer is a boolean — no latency, no cost, no false positives, and nothing for a classifier
// to route.
//
// `report_capability_gap` is the *observation* tool and the reason the improvement loop exists, so
// it stays offered whenever a report could land: collection on, or undecided with a human present to
// answer the consent prompt its first call raises. Only when nothing can be recorded is it withdrawn
// -- collection switched off, or undecided in a headless session that can never ask. Its schema and
// guidance were about 2.5 KB of every request, paid in exactly the sessions where it always answered
// "Not recorded".

import { fileURLToPath } from "node:url";

/** Only usable while an improvement is selected. */
export const AUTHORING_TOOL_NAMES = Object.freeze(["record_harness_contract", "finish_harness_improvement"]);

/** The observation tool. */
export const OBSERVATION_TOOL_NAME = "report_capability_gap";

/**
 * The improvement skill is hidden from the model's skill list (`disable-model-invocation`), because it
 * only ever runs from a /harness-improvement selection. Installed resources and the npm package share
 * the same layout, so the path is resolved from this file rather than from the agent directory.
 */
export function improvementSkillPath() {
    return fileURLToPath(new URL("../../skills/specpi-improve/SKILL.md", import.meta.url));
}

/** Whether a report could be recorded in this session, which is the only reason to offer the tool. */
export function observationToolWanted(mode, interactive) {
    return mode === "on" || (mode === "undecided" && interactive === true);
}

/**
 * Add or remove named tools without disturbing any other extension's tools. Mirrors the
 * web-access gate: it only ever touches the names it owns, and it does nothing when the active set
 * already matches, so a no-op never costs the cached prompt prefix.
 */
function syncOwnedTools(pi, names, wanted) {
    if (typeof pi?.getActiveTools !== "function" || typeof pi?.setActiveTools !== "function") {
        return false;
    }

    const owned = new Set(names);
    const active = pi.getActiveTools();
    const present = active.filter((name) => owned.has(name));
    if (wanted && present.length === owned.size) {
        return false;
    }

    if (!wanted && present.length === 0) {
        return false;
    }

    const others = active.filter((name) => !owned.has(name));
    pi.setActiveTools(wanted ? [...others, ...names] : others);

    return true;
}

export function syncAuthoringTools(pi, selected) {
    return syncOwnedTools(pi, AUTHORING_TOOL_NAMES, selected);
}

export function syncObservationTool(pi, wanted) {
    return syncOwnedTools(pi, [OBSERVATION_TOOL_NAME], wanted);
}

// SpecPi withdraws optional tool groups so their schemas stay out of every request. A human
// normally restores one with /webaccess or /browser, which requires knowing up front that the
// session will need it. This table lets the model name a withdrawn group instead, so the need
// surfaces as a confirmation prompt at the moment it arises.
//
// Activation remains additive and human-confirmed. This file owns no preference and no state:
// it maps a capability name to the tool names its owning package registered, and reports what
// is already active.

import { WEB_TOOL_NAMES } from "./web-access.mjs";

/**
 * Browser QA's fourteen tools, fixed by the pinned specpi-browser-qa release. Names absent
 * from Pi's registry are ignored by setActiveTools, so a core-only install degrades to a
 * clear "not installed" result rather than a broken activation.
 */
export const BROWSER_TOOL_NAMES = Object.freeze([
    "browser_accessibility",
    "browser_open",
    "browser_set_viewport",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_diagnostics",
    "browser_press",
    "browser_select_option",
    "browser_wait_for",
    "browser_screenshot",
    "browser_save_baseline",
    "browser_compare_screenshot",
    "browser_close",
]);

/**
 * Delegation is deliberately absent. `/delegate on` binds a model and host and refuses
 * without an interactive human, and the delegate tool re-synchronizes the active set from
 * the package's own state when it finishes, so a tool-name activation would undo itself.
 * Delegation needs an activation path inside its own package.
 */
/**
 * Restoring a group mid-session costs twice, and only one of those costs was ever stated.
 *
 * `schemaCost` is the standing price: those bytes ride every request until the group is withdrawn
 * again. `activationCost` is the one-off, and it is much larger. Adding tool schemas partway
 * through a session is not an additive change the provider can absorb -- it invalidates the cached
 * prompt prefix, and the next request pays fresh input rates for the whole conversation so far.
 *
 * This was believed and reasoned about here for a long time and never measured. It is measured now.
 * Three attempts on `t3-cascade-ledger` flipped the browser group on at turn 6: in all three,
 * cached tokens collapsed to 3,200 at the next request while the prompt kept climbing, and the
 * re-warm cost 14.6%, 21.6% and 23.9% of the attempt -- 20% on average, against a threshold of 10%
 * fixed before the run. See `evals/runs/cache-probe/` and `scripts/cache-probe.mjs`.
 *
 * The same run says what to do about it: arming the same group from the first request cost 16% more
 * than never arming it at all, against 47% for flipping mid-session. Paying up front is roughly
 * three times cheaper than paying when the need appears.
 */
export const CAPABILITIES = Object.freeze({
    web: {
        label: "Web access",
        tools: WEB_TOOL_NAMES,
        schemaCost: "about 11 KB of tool schema per request",
        // Not measured directly, and deliberately not extrapolated into a number. It is the larger
        // schema, and pi-web-access is a third-party package that still carries promptSnippet and
        // promptGuidelines, so activating it rebuilds the system prompt as well as the tool schema
        // -- a second invalidation path Browser QA no longer has.
        activationCost:
            "and discards the cached prompt prefix once, which is not measured for this group but is at least as expensive as Browser QA's 20% of attempt cost, because its schema is larger and activating it also rebuilds the system prompt",
        summary: "search the web and fetch page or source content",
        command: "/webaccess",
    },
    browser: {
        label: "Browser QA",
        tools: BROWSER_TOOL_NAMES,
        schemaCost: "about 8.7 KB of tool schema per request",
        activationCost:
            "and discards the cached prompt prefix once, measured at about 20% of a mid-length attempt's cost",
        summary: "open pages in an isolated browser to verify rendering, behavior and accessibility",
        command: "/browser",
    },
});

export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));

export function capabilityNames() {
    return [...CAPABILITY_NAMES];
}

export function findCapability(name) {
    if (typeof name !== "string") {
        return undefined;
    }

    return Object.hasOwn(CAPABILITIES, name.trim().toLowerCase())
        ? { id: name.trim().toLowerCase(), ...CAPABILITIES[name.trim().toLowerCase()] }
        : undefined;
}

/** A capability counts as active only when every tool it owns is active. */
export function capabilityActive(activeTools, capability) {
    const active = new Set(activeTools);

    return capability.tools.every((name) => active.has(name));
}

/**
 * Tools the capability would add. An empty list means the group is already fully active, or
 * that its package is not installed; the caller distinguishes the two by checking the
 * registry.
 */
export function missingTools(activeTools, capability) {
    const active = new Set(activeTools);

    return capability.tools.filter((name) => !active.has(name));
}

/**
 * Whether Pi has the capability's tools registered at all. Registered-but-inactive is the
 * normal withdrawn state; entirely unregistered means the package is not installed.
 */
export function capabilityInstalled(allToolNames, capability) {
    const known = new Set(allToolNames);

    return capability.tools.some((name) => known.has(name));
}

/** The tool the model uses to ask for a withdrawn group. */
export const CAPABILITY_REQUEST_TOOL = "request_capability";

/** Whether any requestable group is installed, i.e. whether asking for one could ever succeed. */
export function anyCapabilityInstalled(allToolNames) {
    return CAPABILITY_NAMES.some((id) => capabilityInstalled(allToolNames, CAPABILITIES[id]));
}

/**
 * Whether to offer the request tool at all. It can only ever ask a human, so a session without one
 * would carry its schema for a tool that always refuses, and a session with no requestable group
 * installed has nothing to ask for.
 */
export function capabilityRequestOffered({ interactive, allToolNames }) {
    return interactive === true && anyCapabilityInstalled(allToolNames);
}

/** One catalogue line per capability, for the tool description and its error results. */
export function describeCapabilities() {
    return CAPABILITY_NAMES.map((id) => `${id}: ${CAPABILITIES[id].summary}`).join("; ");
}

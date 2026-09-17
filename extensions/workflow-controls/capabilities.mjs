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
export const CAPABILITIES = Object.freeze({
    web: {
        label: "Web access",
        tools: WEB_TOOL_NAMES,
        schemaCost: "about 11 KB of tool schema per request",
        summary: "search the web and fetch page or source content",
        command: "/webaccess",
    },
    browser: {
        label: "Browser QA",
        tools: BROWSER_TOOL_NAMES,
        schemaCost: "about 8.7 KB of tool schema per request",
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

/** One catalogue line per capability, for the tool description and its error results. */
export function describeCapabilities() {
    return CAPABILITY_NAMES.map((id) => `${id}: ${CAPABILITIES[id].summary}`).join("; ");
}

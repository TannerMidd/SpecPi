"use strict";

// SpecPi's command-guard extension publishes its session mode as a Pi status widget and
// accepts mode changes only through /guard. Chat reads that published label and asks Pi to
// run the command; Command Guard stays the authority and still confirms every weakening
// change (off, strict to guard, unlock) with the person through its own dialog.
const GUARD_STATUS_KEY = "specpi-command-guard";
const GUARD_ACTIONS = Object.freeze(["guard", "strict", "off", "unlock"]);
const GUARD_LABELS = Object.freeze({
    guard: "Guard",
    strict: "Strict",
    off: "Off",
    locked: "Locked",
    unlock: "Unlock",
});
const GUARD_DETAILS = Object.freeze({
    guard: "Confirmed host-wide destruction is denied. Destructive Git operations and unresolved commands ask first.",
    strict: "Host-wide destruction stays denied. Mutation, execution, sensitive reads and network activity ask first.",
    off: "No command-guard checks for the rest of this session. Pi confirms before turning it off.",
    locked: "A critical attempt locked this session. Protected tool calls are denied until you unlock it.",
    unlock: "Restore the previous mode after reviewing the critical rule. Pi confirms and names the rule first.",
});

function parseGuardMode(statusText) {
    if (typeof statusText !== "string") {
        return undefined;
    }

    // "Guard Off" also contains "guard", so the more specific labels are matched first.
    const label = statusText.toLowerCase();
    for (const mode of ["locked", "off", "strict", "guard"]) {
        if (label.includes(mode)) {
            return mode;
        }
    }

    return undefined;
}

function guardActions(mode) {
    return mode === "locked" ? ["unlock"] : ["guard", "strict", "off"];
}

function guardState(state) {
    const installed = Array.isArray(state?.commands) && state.commands.some((command) => command?.name === "guard");
    const mode = parseGuardMode(state?.runtimeStatus?.[GUARD_STATUS_KEY]);
    if (!installed && !mode) {
        return undefined;
    }

    return {
        mode,
        // Without a published mode the harness is older or has not reported yet; /guard still works.
        label: mode ? GUARD_LABELS[mode] : "Guard",
        detail: mode ? GUARD_DETAILS[mode] : "SpecPi's command guard has not reported a mode for this session.",
        actions: guardActions(mode),
    };
}

module.exports = {
    GUARD_STATUS_KEY,
    GUARD_ACTIONS,
    GUARD_LABELS,
    GUARD_DETAILS,
    parseGuardMode,
    guardActions,
    guardState,
};

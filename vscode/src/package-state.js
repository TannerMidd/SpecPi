"use strict";

// Which pinned packages expose a configuration file Chat can edit, detected
// from the slash commands Pi reports for the live session. A package that is
// not installed offers no target, so the dialog never opens onto a file no
// package reads.
const PACKAGES = [
    {
        id: "webAccess",
        label: "Web access",
        commands: ["websearch", "curator"],
        targets: ["webAccess"],
    },
    // The Jev layer's panel shipped without this entry, and without one nothing could open it:
    // showPackageSettings only honours a target belonging to an installed package, so every attempt
    // was refused as "not installed in this session" and the file the panel writes could only be
    // edited by hand. The advisor registers /jev, which is what makes it detectable here.
    {
        id: "jevLayer",
        label: "Jev layer",
        commands: ["jev"],
        targets: ["jevLayer"],
    },
];

function packageSettingsState(state) {
    const names = new Set((state?.commands || []).map((command) => command.name));
    const installed = PACKAGES.filter((entry) => entry.commands.some((name) => names.has(name)));
    if (installed.length === 0) {
        return undefined;
    }

    return {
        targets: installed.flatMap((entry) => entry.targets),
        label: installed.map((entry) => entry.label).join(" · "),
        detail: `Edit configuration for ${installed.map((entry) => entry.label.toLowerCase()).join(" and ")}. The packages keep enforcing it.`,
    };
}

module.exports = { PACKAGES, packageSettingsState };

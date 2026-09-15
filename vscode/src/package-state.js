"use strict";

// Which pinned packages expose a configuration file Chat can edit, detected
// from the slash commands Pi reports for the live session. A package that is
// not installed offers no target, so the dialog never opens onto a file no
// package reads.
const PACKAGES = [
    {
        id: "subagents",
        label: "Subagents",
        commands: ["subagents-fleet", "subagents-guide"],
        targets: ["subagents:extension", "subagents:global", "subagents:project"],
    },
    {
        id: "webAccess",
        label: "Web access",
        commands: ["websearch", "curator"],
        targets: ["webAccess"],
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

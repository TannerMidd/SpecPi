"use strict";

const { isDeepStrictEqual } = require("node:util");
const { validate, destructiveGuard } = require("../media/permission-config.js");

// Recognise the saved global rules, not effective policy. Rule order matters:
// Permission System uses the last matching pattern. YOLO and display/logging
// options may differ from the preset without changing its deny rules.
function hasDestructiveGuard(text) {
    try {
        const config = validate(text);

        return (
            isDeepStrictEqual(config.authorizerChain, []) &&
            isDeepStrictEqual(
                Object.entries(config.permission || {}).map(([key, value]) => [
                    key,
                    key === "bash" ? Object.entries(value) : value,
                ]),
                Object.entries(destructiveGuard.permission).map(([key, value]) => [
                    key,
                    key === "bash" ? Object.entries(value) : value,
                ]),
            )
        );
    } catch {
        return false;
    }
}

function permissionState(state) {
    if (!state?.commands?.some((command) => command.name === "permission-system")) {
        return undefined;
    }

    const yolo = state.runtimeStatus?.["pi-permission-system"] === "yolo";

    const guard = state.destructiveGuardSaved === true;

    return {
        yolo,
        mode: guard ? "guard-saved" : yolo ? "yolo" : "configured",
        label: guard ? (yolo ? "Guard saved · YOLO" : "Guard saved") : yolo ? "YOLO" : "Permissions",
        detail: guard
            ? `Destructive guard rules were found in the saved global configuration. ${yolo ? "Permission System reports YOLO mode. " : ""}Saved rules do not prove active enforcement; project and agent overrides may differ. Restart Pi after changes. Edit Permission System settings.`
            : yolo
              ? "Permission System reports YOLO mode. Edit settings and permission rules."
              : "Edit Permission System settings and rules. The upstream package enforces them.",
    };
}

module.exports = { permissionState, hasDestructiveGuard };

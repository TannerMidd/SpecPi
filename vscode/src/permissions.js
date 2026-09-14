"use strict";

function permissionState(state) {
    if (!state?.commands?.some((command) => command.name === "permission-system")) {
        return undefined;
    }

    const yolo = state.runtimeStatus?.["pi-permission-system"] === "yolo";

    return {
        yolo,
        label: yolo ? "YOLO" : "Permissions",
        detail: yolo
            ? "Permission System reports YOLO mode. Edit settings and permission rules."
            : "Edit Permission System settings and rules. The upstream package enforces them.",
    };
}

module.exports = { permissionState };

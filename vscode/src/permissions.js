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
            ? "Permission System reports YOLO mode. View its active settings."
            : "View Permission System settings. The upstream package controls approval rules.",
    };
}

module.exports = { permissionState };

export type GuardMode = "off" | "guard" | "strict" | "locked" | "unknown";
export type SelectableGuardMode = Exclude<GuardMode, "locked" | "unknown">;

export type GuardAcknowledgment =
    { outcome: "pending" } | { outcome: "confirmed" } | { outcome: "rejected"; message: string };

export function guardRequestError(available: boolean, mode: GuardMode): string | undefined {
    if (!available || mode === "unknown") {
        return "Command Guard status is unavailable. Update SpecPi before changing protection.";
    }

    if (mode === "locked") {
        return "Command Guard is locked for this session.";
    }

    return undefined;
}

export function acknowledgeGuardMode(expected: SelectableGuardMode, actual: GuardMode): GuardAcknowledgment {
    if (actual === "unknown") {
        return { outcome: "pending" };
    }

    if (actual === expected) {
        return { outcome: "confirmed" };
    }

    return { outcome: "rejected", message: `Command Guard reported ${actual} instead of ${expected}` };
}

export function guardModeFromStatus(statusText: string | undefined): GuardMode {
    const normalized = statusText?.replace(/[🛡π]/gu, "").trim().toLowerCase();
    if (!normalized) {
        return "unknown";
    }

    if (normalized === "locked") {
        return "locked";
    }

    if (normalized === "guard off") {
        return "off";
    }

    if (normalized === "guard" || normalized === "strict") {
        return normalized;
    }

    return "unknown";
}

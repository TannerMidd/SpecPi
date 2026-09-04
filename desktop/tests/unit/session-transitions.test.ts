import { describe, expect, it } from "vitest";
import { newestDesktopState } from "../../src/renderer/src/lib/desktop-state";
import { acknowledgeGuardMode, guardModeFromStatus, guardRequestError } from "../../src/renderer/src/lib/guard-status";
import { invokeLatest } from "../../src/renderer/src/lib/latest-command";
import {
    forkDraft,
    SessionTransitionLock,
    sessionTransitionCancelled,
} from "../../src/renderer/src/lib/session-transitions";
import type { DesktopState } from "../../src/shared/domain";

function state(revision: number): DesktopState {
    return {
        schema: 2,
        revision,
        theme: "dark",
        projects: [],
        sessions: [],
        layout: { filesOpen: false, filesWidth: 420, inspectorOpen: true, sidebarOpen: true },
    };
}

describe("renderer transition contracts", () => {
    it("[B5] serializes session-changing operations until the current transition releases", () => {
        const lock = new SessionTransitionLock();

        expect(lock.acquire()).toBe(true);
        expect(lock.acquire()).toBe(false);
        lock.release();
        expect(lock.acquire()).toBe(true);
    });

    it("[B5] treats only explicit Pi cancellation as cancellation", () => {
        expect(sessionTransitionCancelled({ cancelled: true })).toBe(true);
        expect(sessionTransitionCancelled({ cancelled: false })).toBe(false);
        expect(sessionTransitionCancelled({ cancelled: "true" })).toBe(false);
        expect(sessionTransitionCancelled(undefined)).toBe(false);
    });

    it("[B5] uses Pi's fork text with the selected text as compatibility fallback", () => {
        expect(forkDraft({ text: "Pi text" }, "selected text")).toBe("Pi text");
        expect(forkDraft({}, "selected text")).toBe("selected text");
    });

    it("[C4] does not let a late state response roll back a newer revision", () => {
        expect(newestDesktopState(state(4), state(3)).revision).toBe(4);
        expect(newestDesktopState(state(4), state(5)).revision).toBe(5);
    });

    it("[B6] dispatches shortcuts through the callback that is current at invocation", () => {
        let callback = (value: string) => `old:${value}`;
        const invoke = (value: string) => invokeLatest(() => callback, value);
        callback = (value) => `new:${value}`;

        expect(invoke("draft")).toBe("new:draft");
    });

    it("[C10] accepts only authoritative Command Guard status labels", () => {
        expect(guardModeFromStatus("Guard Off")).toBe("off");
        expect(guardModeFromStatus("🛡 Guard")).toBe("guard");
        expect(guardModeFromStatus("🛡 Strict")).toBe("strict");
        expect(guardModeFromStatus("🛡 Locked")).toBe("locked");
        expect(guardModeFromStatus("Protection probably enabled")).toBe("unknown");
    });

    it("[C10] confirms only matching Guard status and rejects missing, locked, or mismatched state", () => {
        expect(guardRequestError(false, "off")).toContain("Update SpecPi");
        expect(guardRequestError(true, "unknown")).toContain("unavailable");
        expect(guardRequestError(true, "locked")).toContain("locked");
        expect(guardRequestError(true, "off")).toBeUndefined();
        expect(acknowledgeGuardMode("strict", "unknown")).toEqual({ outcome: "pending" });
        expect(acknowledgeGuardMode("strict", "strict")).toEqual({ outcome: "confirmed" });
        expect(acknowledgeGuardMode("strict", "guard")).toMatchObject({ outcome: "rejected" });
        expect(acknowledgeGuardMode("strict", "locked")).toMatchObject({ outcome: "rejected" });
    });
});

import { describe, expect, it } from "vitest";
import { sessionOpenAction, spinupDetail } from "../../src/renderer/src/lib/spinup";

describe("desktop session startup", () => {
    it("starts Pi when a session is clicked before its project runtime is loaded", () => {
        expect(sessionOpenAction("stopped", true)).toBe("activate-runtime");
        expect(sessionOpenAction("failed", true)).toBe("activate-runtime");
        expect(sessionOpenAction("idle")).toBe("activate-runtime");
        expect(sessionOpenAction("waiting-for-user")).toBe("activate-runtime");
        expect(sessionOpenAction("idle", true)).toBe("none");
    });

    it("activates another session without replacing the running session", () => {
        expect(sessionOpenAction("starting")).toBe("activate-runtime");
        expect(sessionOpenAction("streaming")).toBe("activate-runtime");
        expect(sessionOpenAction("compacting")).toBe("activate-runtime");
        expect(sessionOpenAction("retrying")).toBe("activate-runtime");
    });

    it("treats long startup as abnormal and identifies the legacy timeout", () => {
        expect(spinupDetail(0)).toContain("Starting the local Pi runtime");
        expect(spinupDetail(10_000)).toContain("slower than expected");
        expect(spinupDetail(20_000)).toContain("30-second RPC timeout");
    });
});

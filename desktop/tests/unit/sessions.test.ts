import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/shared/domain";
import { mergeSessionRecord } from "../../src/renderer/src/state/sessions";

function session(id: string, sessionPath: string): SessionRecord {
    return {
        id,
        projectId: "project",
        sessionId: id,
        sessionPath,
        lastOpenedAt: new Date().toISOString(),
        draft: "",
    };
}

describe("session registry", () => {
    it("replaces duplicate IDs and Windows path aliases while preserving distinct sessions", () => {
        const current = session("current", "C:\\sessions\\current.jsonl");
        const sessions = mergeSessionRecord(
            [
                session("stale-id", "C:/sessions/current.jsonl"),
                session("current", "C:/sessions/stale-path.jsonl"),
                session("other", "C:/sessions/other.jsonl"),
                session("other-copy", "C:\\sessions\\other.jsonl"),
            ],
            current,
            "win32",
        );

        expect(sessions.map((item) => item.id)).toEqual(["current", "other"]);
    });

    it("preserves case-distinct POSIX session paths", () => {
        const sessions = mergeSessionRecord(
            [session("upper", "/tmp/Session.jsonl")],
            session("lower", "/tmp/session.jsonl"),
            "linux",
        );

        expect(sessions.map((item) => item.id)).toEqual(["lower", "upper"]);
    });
});

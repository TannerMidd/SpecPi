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
    it("replaces duplicate IDs and normalized paths while preserving distinct untitled sessions", () => {
        const current = session("current", "C:\\sessions\\current.jsonl");
        const sessions = mergeSessionRecord(
            [
                session("stale-id", "C:/sessions/current.jsonl"),
                session("current", "C:/sessions/stale-path.jsonl"),
                session("other", "C:/sessions/other.jsonl"),
                session("other-copy", "C:\\sessions\\other.jsonl"),
            ],
            current,
        );

        expect(sessions.map((item) => item.id)).toEqual(["current", "other"]);
    });
});

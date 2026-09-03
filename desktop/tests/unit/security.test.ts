import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "../../src/main/diagnostics";
import { externalUrlSchema, rpcCommandSchema, sessionRecordSchema } from "../../src/shared/schemas";

describe("desktop boundaries", () => {
    it("does not expose direct RPC bash execution", () => {
        expect(rpcCommandSchema.safeParse({ type: "bash", command: "echo unsafe" }).success).toBe(false);
        expect(rpcCommandSchema.safeParse({ type: "prompt", message: "hello" }).success).toBe(true);
        expect(rpcCommandSchema.safeParse({ type: "set_label", entryId: "entry", label: "reviewed" }).success).toBe(
            true,
        );
        expect(rpcCommandSchema.safeParse({ type: "set_label", entryId: "", label: "reviewed" }).success).toBe(false);
    });

    it("bounds locally cached session titles", () => {
        const session = {
            id: "session",
            projectId: "project",
            sessionId: "session",
            sessionPath: "C:/sessions/session.jsonl",
            lastOpenedAt: new Date().toISOString(),
            draft: "",
        };

        expect(sessionRecordSchema.safeParse({ ...session, title: "First prompt title" }).success).toBe(true);
        expect(sessionRecordSchema.safeParse({ ...session, title: "x".repeat(73) }).success).toBe(false);
    });

    it("allows only explicit HTTP(S) external links", () => {
        expect(externalUrlSchema.safeParse("https://pi.dev").success).toBe(true);
        expect(externalUrlSchema.safeParse("https://user:secret@pi.dev").success).toBe(false);
        expect(externalUrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
        expect(externalUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    });

    it("redacts common diagnostic credentials", () => {
        expect(redactDiagnostic("token=abc123 password: hunter2 Bearer signed-value")).not.toContain("abc123");
        expect(redactDiagnostic("token=abc123 password: hunter2 Bearer signed-value")).not.toContain("hunter2");
        expect(redactDiagnostic("token=abc123 password: hunter2 Bearer signed-value")).not.toContain("signed-value");
        const url = redactDiagnostic("https://user:pass@example.test/path?token=secret#private");
        expect(url).not.toContain("user");
        expect(url).not.toContain("pass");
        expect(url).not.toContain("secret");
        expect(url).not.toContain("private");
    });
});

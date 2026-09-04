import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "../../src/main/diagnostics";
import { displayNativePath } from "../../src/main/path-identity";
import { isTrustedRendererUrl, resolveRendererTarget } from "../../src/main/renderer-origin";
import {
    MAX_IMAGE_BASE64_BYTES,
    MAX_RPC_COMMAND_BYTES,
    serializedRpcBytes,
    serializedRpcCommandBytes,
} from "../../src/shared/limits";
import {
    activeSessionMetadataSchema,
    desktopStatePatchSchema,
    desktopStateSchema,
    extensionUiRequestSchema,
    externalUrlSchema,
    fileRequestSchema,
    projectCapabilitySchema,
    rpcCommandSchema,
    sessionRecordSchema,
    workspaceRequestSchema,
} from "../../src/shared/schemas";

describe("desktop boundaries", () => {
    it("[C2] allows only the narrow reviewed renderer RPC command set", () => {
        expect(rpcCommandSchema.safeParse({ type: "bash", command: "echo unsafe" }).success).toBe(false);
        expect(rpcCommandSchema.safeParse({ type: "prompt", message: "hello" }).success).toBe(true);
        expect(rpcCommandSchema.safeParse({ type: "prompt", message: "hello", id: "renderer-id" }).success).toBe(false);
        expect(
            rpcCommandSchema.safeParse({
                type: "prompt",
                message: "hello",
                images: [{ type: "image", data: "", mimeType: "image/png", path: "/tmp/source.png" }],
            }).success,
        ).toBe(false);
        expect(rpcCommandSchema.safeParse({ type: "set_session_name", name: "reviewed" }).success).toBe(true);
        expect(rpcCommandSchema.safeParse({ type: "set_label", entryId: "entry", label: "reviewed" }).success).toBe(
            false,
        );
        expect(rpcCommandSchema.safeParse({ type: "switch_session", sessionPath: "/tmp/other.jsonl" }).success).toBe(
            false,
        );
        expect(rpcCommandSchema.safeParse({ type: "export_html", outputPath: "/tmp/output.html" }).success).toBe(false);
    });

    it("bounds and validates extension UI records before renderer projection", () => {
        expect(
            extensionUiRequestSchema.safeParse({
                type: "extension_ui_request",
                id: "request",
                method: "select",
                title: "Choose",
                options: ["One"],
            }).success,
        ).toBe(true);
        expect(
            extensionUiRequestSchema.safeParse({
                type: "extension_ui_request",
                id: "request",
                method: "select",
                title: "Choose",
                options: "One",
            }).success,
        ).toBe(false);
        expect(
            extensionUiRequestSchema.safeParse({
                type: "extension_ui_request",
                id: "request",
                method: { unsafe: true },
            }).success,
        ).toBe(false);
    });

    it("renders control characters inert in native path consent", () => {
        expect(displayNativePath("/tmp/project\nTrust this run\u202e")).toBe("/tmp/project\\nTrust this run\\u{202e}");
    });

    it("[B3] accepts only ID-based workspace requests and preference-only state patches", () => {
        expect(workspaceRequestSchema.safeParse({ projectId: "project", sessionId: "session" }).success).toBe(true);
        expect(workspaceRequestSchema.safeParse({ projectId: "project", cwd: "/tmp" }).success).toBe(false);
        expect(workspaceRequestSchema.safeParse({ projectId: "project", trust: "approve" }).success).toBe(false);
        expect(
            workspaceRequestSchema.safeParse({ projectId: "project", sessionId: "session", noSession: true }).success,
        ).toBe(false);
        expect(desktopStatePatchSchema.safeParse({ theme: "dark" }).success).toBe(true);
        expect(desktopStatePatchSchema.safeParse({ projects: [] }).success).toBe(false);
        expect(desktopStatePatchSchema.safeParse({ piPath: "/tmp/pi" }).success).toBe(false);
        expect(fileRequestSchema.safeParse({ projectId: "project", relativePath: "src/main.ts" }).success).toBe(true);
        expect(fileRequestSchema.safeParse({ relativePath: "src/main.ts" }).success).toBe(false);
        expect(
            fileRequestSchema.safeParse({ projectId: "project", relativePath: "src/main.ts", projectRoot: "/tmp" })
                .success,
        ).toBe(false);
        expect(projectCapabilitySchema.safeParse({ projectId: "project" }).success).toBe(true);
        expect(projectCapabilitySchema.safeParse({ projectRoot: "/tmp/project" }).success).toBe(false);
        expect(activeSessionMetadataSchema.safeParse({ draft: "safe", sessionPath: "/tmp/forged" }).success).toBe(
            false,
        );
    });

    it("[C1] enforces the aggregate outbound RPC byte ceiling", () => {
        const valid = {
            type: "prompt",
            message: "hello",
            images: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
        };
        expect(rpcCommandSchema.safeParse(valid).success).toBe(true);
        expect(
            rpcCommandSchema.safeParse({
                type: "prompt",
                message: "x".repeat(1_000_000),
                images: [
                    { type: "image", data: "a".repeat(MAX_IMAGE_BASE64_BYTES), mimeType: "image/png" },
                    { type: "image", data: "a".repeat(MAX_IMAGE_BASE64_BYTES), mimeType: "image/png" },
                ],
            }).success,
        ).toBe(false);
        expect(
            rpcCommandSchema.safeParse({
                type: "prompt",
                message: "",
                images: [{ type: "image", data: "a".repeat(MAX_IMAGE_BASE64_BYTES), mimeType: "image/png" }],
            }).success,
        ).toBe(false);
        expect(
            rpcCommandSchema.safeParse({
                type: "prompt",
                message: "",
                images: [
                    {
                        type: "image",
                        data: `${"a".repeat(MAX_IMAGE_BASE64_BYTES - 1)}=`,
                        mimeType: "image/png",
                    },
                ],
            }).success,
        ).toBe(true);
        expect(serializedRpcBytes(valid)).toBeLessThan(MAX_RPC_COMMAND_BYTES);

        const maximumImage = `${"a".repeat(MAX_IMAGE_BASE64_BYTES - 1)}=`;
        const nearLimit = {
            type: "prompt",
            message: "",
            images: [
                { type: "image", data: maximumImage, mimeType: "image/png" },
                { type: "image", data: "", mimeType: "image/png" },
            ],
        };
        const remaining = MAX_RPC_COMMAND_BYTES - serializedRpcCommandBytes(nearLimit);
        nearLimit.images[1]!.data = "a".repeat(Math.floor(remaining / 4) * 4);
        expect(serializedRpcCommandBytes(nearLimit)).toBeLessThanOrEqual(MAX_RPC_COMMAND_BYTES);
        expect(rpcCommandSchema.safeParse(nearLimit).success).toBe(true);

        const overLimit = structuredClone(nearLimit);
        overLimit.images[1]!.data += "aaaa";
        expect(serializedRpcCommandBytes(overLimit)).toBeGreaterThan(MAX_RPC_COMMAND_BYTES);
        expect(rpcCommandSchema.safeParse(overLimit).success).toBe(false);
    });

    it("[C6] rejects malformed nested and relative authoritative state", () => {
        const valid = {
            schema: 2,
            revision: 0,
            theme: "dark",
            projects: [
                {
                    id: "project",
                    path: "/project",
                    label: "project",
                    lastOpenedAt: new Date().toISOString(),
                    pinned: false,
                },
            ],
            sessions: [],
            layout: { filesOpen: false, filesWidth: 420, inspectorOpen: true, sidebarOpen: true },
        };

        expect(desktopStateSchema.safeParse(valid).success).toBe(true);
        expect(desktopStateSchema.safeParse({ ...valid, revision: -1 }).success).toBe(false);
        expect(desktopStateSchema.safeParse({ ...valid, theme: "blue" }).success).toBe(false);
        expect(
            desktopStateSchema.safeParse({ ...valid, layout: { ...valid.layout, filesWidth: "wide" } }).success,
        ).toBe(false);
        expect(
            desktopStateSchema.safeParse({ ...valid, projects: [{ ...valid.projects[0], path: "relative/project" }] })
                .success,
        ).toBe(false);
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

    it("[B3] loads only packaged files or unauthenticated loopback development origins", () => {
        const rendererFile = path.resolve("desktop/out/renderer/index.html");
        const packaged = resolveRendererTarget({
            packaged: true,
            rendererFile,
            developmentUrl: "https://attacker.example",
        });
        expect(packaged.kind).toBe("file");
        expect(isTrustedRendererUrl(packaged.url, packaged)).toBe(true);
        expect(isTrustedRendererUrl("https://attacker.example", packaged)).toBe(false);

        const development = resolveRendererTarget({
            packaged: false,
            rendererFile,
            developmentUrl: "http://127.0.0.1:5173/",
        });
        expect(development.kind).toBe("development");
        expect(isTrustedRendererUrl("http://127.0.0.1:5173/app", development)).toBe(true);
        expect(isTrustedRendererUrl("http://localhost:5173/app", development)).toBe(false);
        expect(() =>
            resolveRendererTarget({
                packaged: false,
                rendererFile,
                developmentUrl: "https://attacker.example",
            }),
        ).toThrow("loopback");
        expect(() =>
            resolveRendererTarget({
                packaged: false,
                rendererFile,
                developmentUrl: "http://user:password@127.0.0.1:5173",
            }),
        ).toThrow("loopback");
    });

    it("[C3] restarts from the current session ID instead of a remembered path", () => {
        const appSource = readFileSync(new URL("../../src/renderer/src/App.tsx", import.meta.url), "utf8");

        expect(appSource).toContain("startProject(selectedProject, activeSessionIdRef.current)");
        expect(appSource).not.toContain("lastSessionPath");
    });

    it("[B7] configures Linux Electron sandbox helpers without disabling the sandbox", () => {
        const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");

        expect(workflow.match(/chown root:root .*chrome-sandbox/gu)).toHaveLength(2);
        expect(workflow.match(/chmod 4755 .*chrome-sandbox/gu)).toHaveLength(2);
        expect(workflow).not.toMatch(/--no-sandbox|ELECTRON_DISABLE_SANDBOX/u);
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

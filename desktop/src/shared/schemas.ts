import { z } from "zod";
import { MAX_SESSION_TITLE_LENGTH } from "./session-title";

const boundedString = z.string().max(1_000_000);

export const rpcRecordSchema = z
    .object({
        type: z.string().min(1).max(128),
        id: z.string().max(256).optional(),
    })
    .passthrough();

const imageSchema = z.object({
    type: z.literal("image"),
    data: z.string().max(20 * 1024 * 1024),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});

const identified = { id: z.string().max(256).optional() };
export const rpcCommandSchema = z.discriminatedUnion("type", [
    z.object({
        ...identified,
        type: z.literal("prompt"),
        message: boundedString,
        images: z.array(imageSchema).max(8).optional(),
        streamingBehavior: z.enum(["steer", "followUp"]).optional(),
    }),
    z.object({
        ...identified,
        type: z.literal("steer"),
        message: boundedString,
        images: z.array(imageSchema).max(8).optional(),
    }),
    z.object({
        ...identified,
        type: z.literal("follow_up"),
        message: boundedString,
        images: z.array(imageSchema).max(8).optional(),
    }),
    z.object({ ...identified, type: z.literal("abort") }),
    z.object({ ...identified, type: z.literal("clear_queue") }),
    z.object({ ...identified, type: z.literal("new_session"), parentSession: z.string().max(32_768).optional() }),
    z.object({ ...identified, type: z.literal("get_state") }),
    z.object({
        ...identified,
        type: z.literal("set_model"),
        provider: z.string().max(256),
        modelId: z.string().max(512),
    }),
    z.object({ ...identified, type: z.literal("cycle_model") }),
    z.object({ ...identified, type: z.literal("get_available_models") }),
    z.object({
        ...identified,
        type: z.literal("set_thinking_level"),
        level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    }),
    z.object({ ...identified, type: z.literal("cycle_thinking_level") }),
    z.object({ ...identified, type: z.literal("get_available_thinking_levels") }),
    z.object({ ...identified, type: z.literal("set_steering_mode"), mode: z.enum(["all", "one-at-a-time"]) }),
    z.object({ ...identified, type: z.literal("set_follow_up_mode"), mode: z.enum(["all", "one-at-a-time"]) }),
    z.object({ ...identified, type: z.literal("compact"), customInstructions: z.string().max(20_000).optional() }),
    z.object({ ...identified, type: z.literal("set_auto_compaction"), enabled: z.boolean() }),
    z.object({ ...identified, type: z.literal("set_auto_retry"), enabled: z.boolean() }),
    z.object({ ...identified, type: z.literal("abort_retry") }),
    z.object({ ...identified, type: z.literal("get_session_stats") }),
    z.object({ ...identified, type: z.literal("export_html"), outputPath: z.string().max(32_768).optional() }),
    z.object({ ...identified, type: z.literal("switch_session"), sessionPath: z.string().min(1).max(32_768) }),
    z.object({ ...identified, type: z.literal("fork"), entryId: z.string().min(1).max(256) }),
    z.object({ ...identified, type: z.literal("clone") }),
    z.object({ ...identified, type: z.literal("get_fork_messages") }),
    z.object({ ...identified, type: z.literal("get_entries"), since: z.string().max(256).optional() }),
    z.object({ ...identified, type: z.literal("get_tree") }),
    z.object({ ...identified, type: z.literal("get_last_assistant_text") }),
    z.object({ ...identified, type: z.literal("set_session_name"), name: z.string().max(200) }),
    z.object({
        ...identified,
        type: z.literal("set_label"),
        entryId: z.string().min(1).max(256),
        label: z.string().max(200).optional(),
    }),
    z.object({ ...identified, type: z.literal("get_messages") }),
    z.object({ ...identified, type: z.literal("get_commands") }),
]);

export const sessionRecordSchema = z.object({
    id: z.string().max(256),
    projectId: z.string().max(256),
    sessionId: z.string().max(256),
    sessionPath: z.string().max(32_768),
    name: z.string().max(200).optional(),
    title: z.string().max(MAX_SESSION_TITLE_LENGTH).optional(),
    model: z.string().max(768).optional(),
    lastOpenedAt: z.string().max(64),
    draft: boundedString,
    scrollTop: z.number().finite().nonnegative().optional(),
});

export const desktopStatePatchSchema = z.object({
    piPath: z.string().max(32_768).optional(),
    theme: z.enum(["system", "dark", "light"]).optional(),
    activeProjectId: z.string().max(256).optional(),
    activeSessionId: z.string().max(256).optional(),
    projects: z
        .array(
            z.object({
                id: z.string().max(256),
                path: z.string().max(32_768),
                label: z.string().max(512),
                lastOpenedAt: z.string().max(64),
                trust: z.enum(["default", "approve", "deny"]),
                pinned: z.boolean(),
                lastSessionPath: z.string().max(32_768).optional(),
            }),
        )
        .max(500)
        .optional(),
    sessions: z.array(sessionRecordSchema).max(2_000).optional(),
    layout: z
        .object({
            filesOpen: z.boolean().optional(),
            filesWidth: z.number().min(280).max(900).optional(),
            inspectorOpen: z.boolean().optional(),
            sidebarOpen: z.boolean().optional(),
        })
        .optional(),
});

export const sessionDraftSchema = z.object({
    sessionId: z.string().min(1).max(256),
    draft: boundedString,
});

export const sessionTitleSchema = z.object({
    sessionId: z.string().min(1).max(256),
    title: z.string().min(1).max(MAX_SESSION_TITLE_LENGTH),
});

export const desktopStateSchema = z.object({
    schema: z.literal(1),
    piPath: z.string().max(32_768).optional(),
    theme: z.enum(["system", "dark", "light"]),
    projects: desktopStatePatchSchema.shape.projects.unwrap(),
    sessions: desktopStatePatchSchema.shape.sessions.unwrap(),
    activeProjectId: z.string().max(256).optional(),
    activeSessionId: z.string().max(256).optional(),
    layout: z.object({
        filesOpen: z.boolean(),
        filesWidth: z.number().min(280).max(900),
        inspectorOpen: z.boolean(),
        sidebarOpen: z.boolean(),
    }),
});

export const runtimeStatusSchema = z.object({
    generation: z.number().int().nonnegative(),
    phase: z.enum(["stopped", "starting", "idle", "streaming", "waiting-for-user", "compacting", "retrying", "failed"]),
    piPath: z.string().max(32_768).optional(),
    piVersion: z.string().max(128).optional(),
    cwd: z.string().max(32_768).optional(),
    error: z.string().max(8_192).optional(),
    compatibilityWarning: z.string().max(1_024).optional(),
});

export const runtimeEventSchema = z.object({
    generation: z.number().int().nonnegative(),
    record: rpcRecordSchema,
});

export const runtimeSnapshotSchema = z.object({
    status: runtimeStatusSchema,
    pendingUi: z.array(rpcRecordSchema).max(256),
});

export const runtimeDescriptorSchema = z.object({
    runtimeId: z.string().uuid(),
    projectPath: z.string().min(1).max(32_768),
    sessionPath: z.string().min(1).max(32_768).optional(),
    active: z.boolean(),
    status: runtimeStatusSchema,
});

export const fileNodeSchema = z.object({
    name: z.string().max(1_024),
    relativePath: z.string().max(32_768),
    kind: z.enum(["file", "directory", "symlink"]),
    size: z.number().nonnegative().optional(),
});

export const filePreviewSchema = z.object({
    relativePath: z.string().max(32_768),
    kind: z.enum(["text", "image", "binary"]),
    content: z
        .string()
        .max(512 * 1024)
        .optional(),
    dataUrl: z
        .string()
        .max(14 * 1024 * 1024)
        .optional(),
    truncated: z.boolean(),
    size: z.number().nonnegative(),
    mimeType: z.string().max(128).optional(),
});

export const gitStatusSchema = z.object({
    available: z.boolean(),
    branch: z.string().max(1_024).optional(),
    files: z
        .array(z.object({ path: z.string().max(32_768), index: z.string().max(2), worktree: z.string().max(2) }))
        .max(20_000),
    error: z.string().max(8_192).optional(),
});

export const startRuntimeSchema = z.object({
    cwd: z.string().min(1).max(32_768),
    piPath: z.string().min(1).max(32_768).optional(),
    trust: z.enum(["default", "approve", "deny"]),
    sessionPath: z.string().min(1).max(32_768).optional(),
    noSession: z.boolean().optional(),
    offline: z.boolean().optional(),
});

export const extensionUiResponseSchema = z
    .object({
        type: z.literal("extension_ui_response"),
        id: z.string().min(1).max(256),
        value: boundedString.optional(),
        confirmed: z.boolean().optional(),
        cancelled: z.literal(true).optional(),
    })
    .refine((value) => value.value !== undefined || value.confirmed !== undefined || value.cancelled === true, {
        message: "Extension UI response requires a value, confirmation, or cancellation",
    });

export const fileRequestSchema = z.object({
    projectRoot: z.string().min(1).max(32_768),
    relativePath: z.string().max(32_768),
});

export const diffRequestSchema = z.object({
    projectRoot: z.string().min(1).max(32_768),
    relativePath: z.string().max(32_768).optional(),
});

export const externalUrlSchema = z
    .string()
    .url()
    .refine((value) => ["https:", "http:"].includes(new URL(value).protocol), {
        message: "Only HTTP(S) links may be opened",
    })
    .refine(
        (value) => {
            const url = new URL(value);

            return !url.username && !url.password;
        },
        { message: "External links may not contain credentials" },
    );

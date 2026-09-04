import { z } from "zod";
import {
    MAX_IMAGE_ATTACHMENT_BYTES,
    MAX_IMAGE_BASE64_BYTES,
    MAX_RPC_COMMAND_BYTES,
    serializedRpcCommandBytes,
} from "./limits";
import { MAX_SESSION_TITLE_LENGTH } from "./session-title";

const boundedString = z.string().max(1_000_000);
const idSchema = z.string().min(1).max(256);
export const absolutePathSchema = z
    .string()
    .min(1)
    .max(32_768)
    .refine(
        (value) => value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(value),
        "Expected an absolute filesystem path",
    );
const pathSchema = absolutePathSchema;

export const rpcRecordSchema = z
    .object({
        type: z.string().min(1).max(128),
        id: z.string().max(256).optional(),
    })
    .passthrough();

const base64ImageSchema = z
    .string()
    .max(MAX_IMAGE_BASE64_BYTES)
    .refine(
        (value) => {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
                return false;
            }

            const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
            const decodedBytes = (value.length / 4) * 3 - padding;

            return decodedBytes <= MAX_IMAGE_ATTACHMENT_BYTES;
        },
        { message: "Image attachment exceeds the decoded size limit" },
    );

const imageSchema = z
    .object({
        type: z.literal("image"),
        data: base64ImageSchema,
        mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    })
    .strict();

const identified = {};
const rpcCommandUnion = z.discriminatedUnion("type", [
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
    z.object({ ...identified, type: z.literal("new_session") }),
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
    z.object({ ...identified, type: z.literal("export_html") }),
    z.object({ ...identified, type: z.literal("fork"), entryId: idSchema }),
    z.object({ ...identified, type: z.literal("clone") }),
    z.object({ ...identified, type: z.literal("get_fork_messages") }),
    z.object({ ...identified, type: z.literal("get_entries"), since: z.string().max(256).optional() }),
    z.object({ ...identified, type: z.literal("get_tree") }),
    z.object({ ...identified, type: z.literal("get_last_assistant_text") }),
    z.object({ ...identified, type: z.literal("set_session_name"), name: z.string().max(200) }),
    z.object({ ...identified, type: z.literal("get_messages") }),
    z.object({ ...identified, type: z.literal("get_commands") }),
]);

const commandFields = new Map<string, ReadonlySet<string>>();
const registerCommandFields = (types: readonly string[], fields: readonly string[] = []) => {
    for (const type of types) {
        commandFields.set(type, new Set(["type", ...fields]));
    }
};

registerCommandFields(["prompt"], ["message", "images", "streamingBehavior"]);
registerCommandFields(["steer", "follow_up"], ["message", "images"]);
registerCommandFields([
    "abort",
    "clear_queue",
    "new_session",
    "get_state",
    "cycle_model",
    "get_available_models",
    "cycle_thinking_level",
    "get_available_thinking_levels",
    "abort_retry",
    "get_session_stats",
    "export_html",
    "clone",
    "get_fork_messages",
    "get_tree",
    "get_last_assistant_text",
    "get_messages",
    "get_commands",
]);
registerCommandFields(["set_model"], ["provider", "modelId"]);
registerCommandFields(["set_thinking_level"], ["level"]);
registerCommandFields(["set_steering_mode", "set_follow_up_mode"], ["mode"]);
registerCommandFields(["compact"], ["customInstructions"]);
registerCommandFields(["set_auto_compaction", "set_auto_retry"], ["enabled"]);
registerCommandFields(["fork"], ["entryId"]);
registerCommandFields(["get_entries"], ["since"]);
registerCommandFields(["set_session_name"], ["name"]);

const strictRpcInput = z.unknown().superRefine((value, context) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
    }

    const type = (value as { type?: unknown }).type;
    const allowed = typeof type === "string" ? commandFields.get(type) : undefined;
    if (!allowed) {
        return;
    }

    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            context.addIssue({ code: "custom", message: `Unexpected field for ${type}: ${key}` });
        }
    }
});

export const rpcCommandSchema = strictRpcInput.pipe(rpcCommandUnion).superRefine((value, context) => {
    if (serializedRpcCommandBytes(value) > MAX_RPC_COMMAND_BYTES) {
        context.addIssue({
            code: "custom",
            message: `Pi RPC command exceeded the ${MAX_RPC_COMMAND_BYTES}-byte size limit`,
        });
    }
});

export const projectRecordSchema = z
    .object({
        id: idSchema,
        path: pathSchema,
        label: z.string().min(1).max(512),
        lastOpenedAt: z.string().max(64),
        pinned: z.boolean(),
        lastSessionId: idSchema.optional(),
    })
    .strict();

export const sessionRecordSchema = z
    .object({
        id: idSchema,
        projectId: idSchema,
        sessionId: idSchema,
        sessionPath: pathSchema,
        name: z.string().max(200).optional(),
        title: z.string().max(MAX_SESSION_TITLE_LENGTH).optional(),
        model: z.string().max(768).optional(),
        lastOpenedAt: z.string().max(64),
        draft: boundedString,
        scrollTop: z.number().finite().nonnegative().optional(),
    })
    .strict();

const layoutSchema = z
    .object({
        filesOpen: z.boolean(),
        filesWidth: z.number().min(280).max(900),
        inspectorOpen: z.boolean(),
        sidebarOpen: z.boolean(),
    })
    .strict();

export const desktopStatePatchSchema = z
    .object({
        theme: z.enum(["system", "dark", "light"]).optional(),
        layout: layoutSchema.partial().optional(),
    })
    .strict();

export const sessionDraftSchema = z.object({ sessionId: idSchema, draft: boundedString }).strict();

export const sessionTitleSchema = z
    .object({ sessionId: idSchema, title: z.string().min(1).max(MAX_SESSION_TITLE_LENGTH) })
    .strict();

export const activeSessionMetadataSchema = z
    .object({
        title: z.string().max(MAX_SESSION_TITLE_LENGTH).optional(),
        model: z.string().max(768).optional(),
        draft: boundedString.optional(),
    })
    .strict();

export const desktopStateSchema = z
    .object({
        schema: z.literal(2),
        revision: z.number().int().nonnegative(),
        piPath: pathSchema.optional(),
        theme: z.enum(["system", "dark", "light"]),
        projects: z.array(projectRecordSchema).max(500),
        sessions: z.array(sessionRecordSchema).max(2_000),
        activeProjectId: idSchema.optional(),
        activeSessionId: idSchema.optional(),
        layout: layoutSchema,
    })
    .strict();

export const legacyDesktopStateSchema = z
    .object({
        schema: z.literal(1),
        piPath: pathSchema.optional(),
        theme: z.enum(["system", "dark", "light"]),
        projects: z
            .array(
                z
                    .object({
                        id: idSchema,
                        path: pathSchema,
                        label: z.string().min(1).max(512),
                        lastOpenedAt: z.string().max(64),
                        trust: z.enum(["default", "approve", "deny"]),
                        pinned: z.boolean(),
                        lastSessionPath: pathSchema.optional(),
                    })
                    .strict(),
            )
            .max(500),
        sessions: z.array(sessionRecordSchema).max(2_000),
        activeProjectId: idSchema.optional(),
        activeSessionId: idSchema.optional(),
        layout: z
            .object({
                filesOpen: z.boolean(),
                filesWidth: z.number().min(280).max(900),
                inspectorOpen: z.boolean().optional(),
                sidebarOpen: z.boolean().optional(),
            })
            .strict(),
    })
    .strict();

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
    projectId: idSchema,
    projectPath: pathSchema,
    sessionId: idSchema.optional(),
    sessionPath: pathSchema.optional(),
    active: z.boolean(),
    status: runtimeStatusSchema,
});

export const workspaceRequestSchema = z
    .object({
        projectId: idSchema,
        sessionId: idSchema.optional(),
        importToken: z.string().uuid().optional(),
        noSession: z.boolean().optional(),
        offline: z.boolean().optional(),
    })
    .strict()
    .refine(
        (value) =>
            Number(value.sessionId !== undefined) +
                Number(value.importToken !== undefined) +
                Number(value.noSession === true) <=
            1,
        { message: "Choose only one session launch mode" },
    );

export const runtimeStartResultSchema = z.object({
    cancelled: z.boolean(),
    status: runtimeStatusSchema.optional(),
});

export const sessionImportSelectionSchema = z.object({
    token: z.string().uuid(),
    name: z.string().min(1).max(1_024),
});

const extensionUiRequestBase = {
    type: z.literal("extension_ui_request"),
    id: idSchema,
};
const extensionUiTitle = z.string().max(32_768);
const extensionUiTimeout = z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1_000)
    .optional();
const knownExtensionUiRequestSchema = z.discriminatedUnion("method", [
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("select"),
        title: extensionUiTitle,
        options: z.array(z.string().max(32_768)).max(256),
        timeout: extensionUiTimeout,
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("confirm"),
        title: extensionUiTitle,
        message: boundedString,
        timeout: extensionUiTimeout,
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("input"),
        title: extensionUiTitle,
        placeholder: z.string().max(32_768).optional(),
        timeout: extensionUiTimeout,
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("editor"),
        title: extensionUiTitle,
        prefill: boundedString.optional(),
        timeout: extensionUiTimeout,
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("notify"),
        message: boundedString,
        notifyType: z.enum(["info", "warning", "error"]).optional(),
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("setStatus"),
        statusKey: idSchema,
        statusText: z.string().max(32_768).optional(),
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("setWidget"),
        widgetKey: idSchema,
        widgetLines: z.array(z.string().max(32_768)).max(256).optional(),
        widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("setTitle"),
        title: extensionUiTitle,
    }),
    z.object({
        ...extensionUiRequestBase,
        method: z.literal("set_editor_text"),
        text: boundedString,
    }),
]);
const knownExtensionUiMethods = new Set([
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
]);
const unknownExtensionUiRequestSchema = z
    .object({
        ...extensionUiRequestBase,
        method: z.string().min(1).max(128),
        title: extensionUiTitle.optional(),
    })
    .refine((value) => !knownExtensionUiMethods.has(value.method), { message: "Malformed known extension UI method" });
export const extensionUiRequestSchema = z.union([knownExtensionUiRequestSchema, unknownExtensionUiRequestSchema]);

export const extensionUiResponseSchema = z
    .object({
        type: z.literal("extension_ui_response"),
        id: idSchema,
        value: boundedString.optional(),
        confirmed: z.boolean().optional(),
        cancelled: z.literal(true).optional(),
    })
    .strict()
    .refine((value) => value.value !== undefined || value.confirmed !== undefined || value.cancelled === true, {
        message: "Extension UI response requires a value, confirmation, or cancellation",
    });

export const relativePathSchema = z.string().max(32_768);
export const projectCapabilitySchema = z.object({ projectId: idSchema }).strict();
export const fileRequestSchema = z.object({ projectId: idSchema, relativePath: relativePathSchema }).strict();
export const diffRequestSchema = z
    .object({ projectId: idSchema, relativePath: relativePathSchema.optional() })
    .strict();

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
        .array(
            z.object({
                path: z.string().max(32_768),
                originalPath: z.string().max(32_768).optional(),
                index: z.string().max(2),
                worktree: z.string().max(2),
            }),
        )
        .max(20_000),
    error: z.string().max(8_192).optional(),
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

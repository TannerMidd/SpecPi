"use strict";

const { normalizeImage } = require("./images.js");

const MAX_ENTRIES = 20_000;
const MAX_PROMPT_CHARS = 64 * 1024;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_EXPORT_CHARS = 2_000_000;

function capture(controller, { connected = true, idle = true } = {}) {
    controller.requireWorkspace();
    if (controller.disposed) {
        throw new Error("SpecPi Chat has closed.");
    }

    if (controller.isForeground && !controller.isForeground()) {
        throw new Error("Select this conversation before using its conversation actions.");
    }

    if (connected && !controller.client) {
        throw new Error("Connect Pi before using this conversation action.");
    }

    if (
        idle &&
        (controller.state.status !== "ready" ||
            controller.sending ||
            controller.transitioning ||
            controller.state.queueCount > 0)
    ) {
        throw new Error("Wait for Pi to finish, or stop the response, before changing this conversation.");
    }

    return {
        client: controller.client,
        generation: controller.generation,
        sessionRevision: controller.sessionRevision,
        workspace: controller.workspace,
        catalog: controller.catalog,
        sessionId: controller.activeSessionId,
        idle,
    };
}

function current(controller, snapshot, { identityOnly = false } = {}) {
    try {
        controller.requireWorkspace();
    } catch {
        return false;
    }

    return (
        !controller.disposed &&
        (!controller.isForeground || controller.isForeground()) &&
        controller.client === snapshot.client &&
        controller.generation === snapshot.generation &&
        controller.sessionRevision === snapshot.sessionRevision &&
        controller.workspace === snapshot.workspace &&
        controller.catalog === snapshot.catalog &&
        controller.activeSessionId === snapshot.sessionId &&
        (identityOnly ||
            !snapshot.idle ||
            (controller.state.status === "ready" &&
                !controller.sending &&
                !controller.transitioning &&
                !(controller.state.queueCount > 0)))
    );
}

function activeEntries(data) {
    if (!data || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES) {
        throw new Error("Pi returned an invalid or oversized conversation tree. This chat cannot be edited here.");
    }

    const entries = new Map();
    for (const entry of data.entries) {
        if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 256 || entries.has(entry.id)) {
            throw new Error("Pi returned invalid conversation entry identifiers.");
        }

        entries.set(entry.id, entry);
    }

    const branch = [];
    const visited = new Set();
    let id = data.leafId;
    if (id === null) {
        return branch;
    }

    while (id !== null) {
        if (typeof id !== "string" || visited.has(id) || !entries.has(id)) {
            throw new Error("Pi returned an incomplete or cyclic active conversation branch.");
        }

        visited.add(id);
        const entry = entries.get(id);
        branch.push(entry);
        id = entry.parentId;
    }

    return branch.reverse();
}

function promptContent(entry) {
    if (entry.type !== "message" || entry.message?.role !== "user") {
        throw new Error("The selected conversation entry is no longer a user message.");
    }

    const content = entry.message.content;
    if (typeof content === "string") {
        if (content.length > MAX_PROMPT_CHARS) {
            throw new Error("This prompt exceeds the composer limit and cannot be edited without losing content.");
        }

        return { text: content, images: [] };
    }

    if (!Array.isArray(content)) {
        throw new Error("The selected prompt has unsupported content.");
    }

    let text = "";
    const images = [];
    let bytes = 0;
    for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
            text += part.text;
            if (text.length > MAX_PROMPT_CHARS) {
                throw new Error("This prompt exceeds the composer limit and cannot be edited without losing content.");
            }
        } else if (part?.type === "image") {
            if (images.length >= MAX_IMAGES) {
                throw new Error(
                    "This prompt has more than eight images and cannot be restored without losing content.",
                );
            }

            const image = normalizeImage(part);
            bytes += image.byteLength;
            if (bytes > MAX_IMAGE_BYTES) {
                throw new Error("The selected prompt's images exceed the 20 MiB attachment limit.");
            }

            images.push(image);
        } else {
            throw new Error("The selected prompt contains unsupported content. No conversation changes were made.");
        }
    }

    return { text, images };
}

function preview(entry) {
    const content = entry.message.content;
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                    .filter((part) => part?.type === "text" && typeof part.text === "string")
                    .map((part) => part.text)
                    .join("")
              : "";
    const images = Array.isArray(content) ? content.filter((part) => part?.type === "image").length : 0;

    return {
        label:
            text
                .replace(/[\r\n\t]+/g, " ")
                .trim()
                .slice(0, 160) || (images ? "Image prompt" : "Empty prompt"),
        description: images ? `${images} image${images === 1 ? "" : "s"}` : undefined,
        detail: "Create a conversation branch before this message and restore it to the composer. Code files remain unchanged.",
        entryId: entry.id,
    };
}

async function transition(controller, snapshot, command, payload, draft) {
    if (!current(controller, snapshot)) {
        return false;
    }

    return controller.branchConversation(command, payload, draft);
}

async function editPrompt(controller, vscode) {
    const snapshot = capture(controller);
    try {
        const original = await snapshot.client.request("get_entries");
        if (!current(controller, snapshot)) {
            return false;
        }

        const users = activeEntries(original).filter(
            (entry) => entry.type === "message" && entry.message?.role === "user",
        );
        if (!users.length) {
            await vscode.window.showInformationMessage("This conversation has no earlier prompt to edit.");

            return false;
        }

        const selection = await vscode.window.showQuickPick(users.map(preview).reverse(), {
            title: "SpecPi Chat · Edit an earlier prompt",
            placeHolder: "Choose a prompt to edit in a new conversation branch; code files stay unchanged",
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selection || !current(controller, snapshot)) {
            return false;
        }

        const selected = users.find((entry) => entry.id === selection.entryId);
        if (!selected) {
            throw new Error("Choose a prompt from the current conversation.");
        }

        // Capture exact original text and images before Pi forks. Its fork response
        // includes text only, and must not become the source of restored content.
        const draft = promptContent(selected);
        const latest = await snapshot.client.request("get_entries");
        if (!current(controller, snapshot)) {
            return false;
        }

        const latestSelected = activeEntries(latest).find((entry) => entry.id === selected.id);
        if (
            latest.leafId !== original.leafId ||
            !latestSelected ||
            latestSelected.parentId !== selected.parentId ||
            JSON.stringify(latestSelected.message) !== JSON.stringify(selected.message)
        ) {
            throw new Error("The conversation changed while choosing a prompt. Open Edit an Earlier Prompt again.");
        }

        return transition(controller, snapshot, "fork", { entryId: selected.id }, draft);
    } catch (error) {
        if (!current(controller, snapshot, { identityOnly: true })) {
            return false;
        }

        throw error;
    }
}

async function forkChat(controller, vscode) {
    const snapshot = capture(controller);
    try {
        const entries = await snapshot.client.request("get_entries");
        if (!current(controller, snapshot)) {
            return false;
        }

        if (!activeEntries(entries).length) {
            await vscode.window.showInformationMessage("Send a message before branching this conversation.");

            return false;
        }

        return transition(controller, snapshot, "clone", {}, { text: "", images: [] });
    } catch (error) {
        if (!current(controller, snapshot, { identityOnly: true })) {
            return false;
        }

        throw error;
    }
}

function valueText(value, limit = 100_000) {
    return typeof value === "string" ? value.slice(0, limit) : "";
}

function codeBlock(text) {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);

    return `${fence}\n${text}\n${fence}`;
}

function markdownTranscript(state) {
    const title = valueText(state?.title, 160).replace(/[\r\n]+/g, " ") || "SpecPi Chat";
    const lines = [
        `# ${title}`,
        "",
        "Visible conversation export. Images appear as placeholders; earlier truncated content is not reconstructed.",
        "",
    ];
    if (state?.workspace) {
        lines.push(`Workspace: ${valueText(state.workspace, 512).replace(/[\r\n]+/g, " ")}`, "");
    }

    for (const message of Array.isArray(state?.messages) ? state.messages.slice(-500) : []) {
        if (!message || !["user", "assistant", "tool", "notice"].includes(message.role)) {
            continue;
        }

        const role =
            message.role === "tool"
                ? `Tool · ${valueText(message.toolName, 128) || "tool"}`
                : message.role[0].toUpperCase() + message.role.slice(1);
        lines.push(`## ${role.replace(/[\r\n]+/g, " ")}`, "");
        if (message.isError || message.isRunning) {
            lines.push(message.isError ? "Status: error" : "Status: in progress", "");
        }

        if (typeof message.input === "string" && message.input) {
            lines.push("### Tool input", "", codeBlock(valueText(message.input, 16_000)), "");
        }

        if (typeof message.thinking === "string" && message.thinking) {
            lines.push("### Thinking", "", valueText(message.thinking), "");
        }

        if (message.text) {
            lines.push(valueText(message.text), "");
        }

        for (const file of Array.isArray(message.files) ? message.files.slice(0, 8) : []) {
            lines.push(`Attached file: ${JSON.stringify(valueText(file?.label, 1_024))}`, "");
        }

        for (const image of Array.isArray(message.images) ? message.images.slice(0, MAX_IMAGES) : []) {
            const mime =
                typeof image?.mimeType === "string" && /^image\/[a-zA-Z0-9.+-]+$/.test(image.mimeType)
                    ? image.mimeType
                    : "image";
            const dimensions =
                Number.isInteger(image?.width) && Number.isInteger(image?.height)
                    ? `, ${image.width} × ${image.height}`
                    : "";
            lines.push(`[Image omitted: ${mime}${dimensions}]`, "");
        }

        if (lines.reduce((sum, line) => sum + line.length + 1, 0) > MAX_EXPORT_CHARS) {
            lines.push("[Export truncated at the visible transcript size limit.]", "");
            break;
        }
    }

    const result = lines.join("\n");

    return result.length > MAX_EXPORT_CHARS
        ? `${result.slice(0, MAX_EXPORT_CHARS)}\n\n[Export truncated at the visible transcript size limit.]\n`
        : result;
}

async function exportChat(controller, vscode) {
    const snapshot = capture(controller, { connected: false, idle: false });
    try {
        const content = markdownTranscript(controller.state);
        const document = await vscode.workspace.openTextDocument({ content, language: "markdown" });
        if (!current(controller, snapshot)) {
            return false;
        }

        await vscode.window.showTextDocument(document, { preview: false });

        return true;
    } catch (error) {
        if (!current(controller, snapshot, { identityOnly: true })) {
            return false;
        }

        throw error;
    }
}

function amount(value, { currency = false, percent = false } = {}) {
    if (!Number.isFinite(value) || value < 0) {
        return "Unavailable";
    }

    return `${currency ? "$" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: currency ? 6 : percent ? 2 : 0 })}${percent ? "%" : ""}`;
}

async function showUsage(controller, vscode) {
    const snapshot = capture(controller, { idle: false });
    if (controller.transitioning || !["ready", "busy", "retrying", "compacting"].includes(controller.state.status)) {
        throw new Error("Wait for Pi to connect or finish switching conversations before viewing usage.");
    }

    try {
        const usage = await snapshot.client.request("get_session_stats");
        if (!current(controller, snapshot)) {
            return false;
        }

        const entries = [
            { label: "Input tokens", description: amount(usage?.tokens?.input) },
            { label: "Output tokens", description: amount(usage?.tokens?.output) },
            { label: "Cache read tokens", description: amount(usage?.tokens?.cacheRead) },
            { label: "Cache write tokens", description: amount(usage?.tokens?.cacheWrite) },
            { label: "Total session tokens", description: amount(usage?.tokens?.total) },
            { label: "Reported cost (USD)", description: amount(usage?.cost, { currency: true }) },
            {
                label: "Current context tokens",
                description: amount(usage?.contextUsage?.tokens),
                detail: "Unavailable after compaction until Pi receives fresh usage data.",
            },
            { label: "Context window", description: amount(usage?.contextUsage?.contextWindow) },
            { label: "Context used", description: amount(usage?.contextUsage?.percent, { percent: true }) },
            { label: "Tool calls", description: amount(usage?.toolCalls) },
        ];
        await vscode.window.showQuickPick(entries, {
            title: "SpecPi Chat · Session usage",
            placeHolder: "Pi totals include compacted content and other branches in this session",
        });

        return true;
    } catch (error) {
        if (!current(controller, snapshot, { identityOnly: true })) {
            return false;
        }

        throw error;
    }
}

module.exports = { editPrompt, forkChat, exportChat, showUsage, markdownTranscript };

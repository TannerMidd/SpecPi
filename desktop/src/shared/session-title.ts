export const MAX_SESSION_TITLE_LENGTH = 72;
const TERMINAL_ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const NON_DESCRIPTIVE_COMMANDS = new Set([
    "abort",
    "challenge",
    "clear",
    "compact",
    "context",
    "cost",
    "exit",
    "experiment",
    "export",
    "files",
    "guard",
    "handoff",
    "harness-improvement",
    "help",
    "model",
    "name",
    "quit",
    "reload",
    "rename",
    "resume",
    "settings",
    "scope",
    "spec",
    "thinking",
    "tree",
    "usage",
    "wishlist",
]);

function textContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .flatMap((block) => {
            if (!block || typeof block !== "object") {
                return [];
            }

            const value = block as Record<string, unknown>;

            return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
        })
        .join(" ");
}

function truncateTitle(value: string): string {
    const points = Array.from(value);
    if (points.length <= MAX_SESSION_TITLE_LENGTH) {
        return value;
    }

    const clipped = points.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join("");
    const wordBoundary = clipped.lastIndexOf(" ");
    const head = wordBoundary >= Math.floor(MAX_SESSION_TITLE_LENGTH * 0.6) ? clipped.slice(0, wordBoundary) : clipped;

    return `${head.replace(/[,:;.!?\s-]+$/u, "")}…`;
}

/** Derive a stable, local-only display title without adding a model request. */
export function sessionTitleFromPrompt(prompt: string): string | undefined {
    let candidate = prompt
        .replace(TERMINAL_ESCAPE_SEQUENCE, "")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    if (!candidate) {
        return undefined;
    }

    const command = /^\/([^\s]+)(?:\s+(.*))?$/u.exec(candidate);
    if (command) {
        const commandName = command[1]?.toLowerCase();
        const argumentsText = command[2]?.trim();
        if (!argumentsText || (commandName && NON_DESCRIPTIVE_COMMANDS.has(commandName))) {
            return undefined;
        }

        candidate = argumentsText;
    }

    candidate = candidate
        .replace(/^#{1,6}\s+/u, "")
        .replace(/^(?:[-+*]|\d+[.)]|>)\s+/u, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replace(/`([^`]+)`/gu, "$1")
        .replace(/\s+/gu, " ")
        .trim();

    return /[\p{L}\p{N}]/u.test(candidate) ? truncateTitle(candidate) : undefined;
}

export function sessionTitleFromMessages(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) {
        return undefined;
    }

    for (const message of messages) {
        if (!message || typeof message !== "object") {
            continue;
        }

        const value = message as Record<string, unknown>;
        if (value.role !== "user") {
            continue;
        }

        const title = sessionTitleFromPrompt(textContent(value.content));
        if (title) {
            return title;
        }
    }

    return undefined;
}

export function sessionDisplayTitle(name?: string, title?: string): string {
    return name?.trim() || title?.trim() || "New session";
}

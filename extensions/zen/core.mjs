const PHASES = new Map([
    ["ready", { index: "00", label: "READY" }],
    ["thinking", { index: "01", label: "INTAKE" }],
    ["reasoning", { index: "02", label: "ANALYZE" }],
    ["synthesizing", { index: "04", label: "SYNTHESIZE" }],
]);

function safeDetail(value) {
    return String(value ?? "")
        .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
        .toUpperCase();
}

export function describeZenPhase(phase) {
    const fixed = PHASES.get(phase);
    if (fixed) {
        return { ...fixed, detail: "" };
    }

    if (phase.startsWith("using ")) {
        return { index: "03", label: "TOOL", detail: safeDetail(phase.slice(6)) || "UNKNOWN" };
    }

    if (phase.endsWith(" failed")) {
        return { index: "!!", label: "FAULT", detail: safeDetail(phase.slice(0, -7)) || "UNKNOWN" };
    }

    return { index: "02", label: "ANALYZE", detail: safeDetail(phase) };
}

export function transformZenMarkdown(markdown, context, enabled) {
    if (!enabled) {
        return markdown;
    }

    if (context.messageType === "assistant-thinking") {
        return "> **01 / REASONING** · working trace sealed in Zen mode";
    }

    if (context.messageType === "assistant" && context.isStreaming) {
        return "> **04 / SYNTHESIS** · response held until complete";
    }

    return markdown;
}

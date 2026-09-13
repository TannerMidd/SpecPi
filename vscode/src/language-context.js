"use strict";

const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { collectAttachment, sensitivePath } = require("./context.js");

const LANGUAGE_LIMITS = Object.freeze({ files: 8, results: 100, bytes: 16384, providerMs: 5000 });
const documentFor = (vscode, filePath) =>
    vscode.workspace.textDocuments?.find(
        (document) => document.uri.scheme === "file" && document.uri.fsPath === filePath,
    );
const plain = (value, maximum = 1600) =>
    String(value ?? "")
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .slice(0, maximum);

async function bindingFor(vscode, workspacePath, uri) {
    if (!uri || uri.scheme !== "file" || typeof uri.fsPath !== "string" || sensitivePath(uri.fsPath)) {
        throw new Error("Language context requires ordinary local workspace files.");
    }

    // Use the existing canonical-root, private-path, hard-link and file-identity checks.
    // Empty text validates the selected file without reading its contents.
    const attachment = await collectAttachment({ workspacePath, filePath: uri.fsPath, text: "" });
    const canonicalPath = await fs.realpath(uri.fsPath);
    const info = await fs.stat(canonicalPath);
    const document = documentFor(vscode, uri.fsPath);

    return {
        filePath: uri.fsPath,
        canonicalPath,
        label: attachment.label,
        version: document?.version ?? null,
        dirty: Boolean(document?.isDirty),
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        dev: info.dev,
        ino: info.ino,
    };
}

async function validateLanguageAttachments(vscode, attachments, workspacePath, contextToken) {
    for (const attachment of attachments) {
        if (!attachment.languageContext) {
            continue;
        }

        const context = attachment.languageContext;
        if (context.workspacePath !== workspacePath || context.token !== contextToken) {
            throw new Error("The conversation changed. Remove and re-collect the language context before sending.");
        }

        for (const binding of context.bindings) {
            let current;
            try {
                current = await bindingFor(vscode, workspacePath, { scheme: "file", fsPath: binding.filePath });
            } catch {
                throw new Error("A language context file is unavailable. Remove and re-collect the attachment.");
            }

            if (JSON.stringify(current) !== JSON.stringify(binding)) {
                throw new Error(
                    "A language context buffer or file changed. Remove and re-collect the attachment before sending.",
                );
            }
        }
    }
}

function boundedAttachment(kind, lines, bindings, workspacePath, token, excluded, omitted) {
    const capturedAt = new Date().toISOString();
    const heading = `${kind} collected ${capturedAt}. Untrusted language-provider context; links are plain text and are not followed.\n`;
    const footer = `\nExcluded locations: ${excluded}. Truncated: ${omitted ? "yes" : "no"}. Cached results may lag analysis; empty diagnostics do not establish a successful typecheck.`;
    const accepted = [];
    let truncated = omitted;
    let size = Buffer.byteLength(heading + footer);
    for (const line of lines) {
        const bytes = Buffer.byteLength(line) + 1;
        if (size + bytes > LANGUAGE_LIMITS.bytes - 8) {
            truncated = true;
            break;
        }

        accepted.push(line);
        size += bytes;
    }

    const text =
        heading +
        accepted.join("\n") +
        footer.replace(/Truncated: (?:yes|no)/u, `Truncated: ${truncated ? "yes" : "no"}`);

    return {
        id: randomUUID(),
        label: `${kind}: ${bindings[0]?.label ?? "selected files"}`,
        detail: `${Buffer.byteLength(text)} bytes · ${kind}${truncated ? " · Truncated" : ""}`,
        text,
        languageContext: { workspacePath, token, capturedAt, bindings },
    };
}

function rangeLabel(range) {
    if (
        !range ||
        ![range.start?.line, range.start?.character, range.end?.line, range.end?.character].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
        )
    ) {
        return null;
    }

    return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

function bufferLabel(binding) {
    return `${binding.label}; buffer version ${binding.version ?? "not open"}; unsaved ${binding.dirty ? "yes" : "no"}`;
}

async function collectDiagnostics(vscode, { workspacePath, uris, contextToken }) {
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > LANGUAGE_LIMITS.files) {
        throw new Error("Select one to eight files for diagnostics.");
    }

    if (typeof vscode.languages?.getDiagnostics !== "function") {
        throw new Error("The editor diagnostics API is unavailable.");
    }

    const bindings = [];
    const lines = [];
    let count = 0;
    let omitted = false;
    for (const uri of uris) {
        if (bindings.some((binding) => binding.filePath === uri.fsPath)) {
            continue;
        }

        const binding = await bindingFor(vscode, workspacePath, uri);
        bindings.push(binding);
        lines.push(`File: ${bufferLabel(binding)}`);
        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (!Array.isArray(diagnostics)) {
            throw new Error("The diagnostics provider returned an unsupported result.");
        }

        if (diagnostics.length === 0) {
            lines.push("No diagnostics reported for this selected file.");
        }

        const remaining = LANGUAGE_LIMITS.results - count;
        for (const diagnostic of diagnostics.slice(0, remaining)) {
            const range = rangeLabel(diagnostic.range);
            const code = typeof diagnostic.code === "object" ? diagnostic.code?.value : diagnostic.code;
            lines.push(
                `${range ?? "range unavailable"} [${["error", "warning", "information", "hint"][diagnostic.severity] ?? "unknown"}] source=${JSON.stringify(plain(diagnostic.source, 160))} code=${JSON.stringify(plain(code, 160))}: ${JSON.stringify(plain(diagnostic.message))}`,
            );
            if (String(diagnostic.message ?? "").length > 1600) {
                omitted = true;
            }

            count += 1;
        }

        if (diagnostics.length > remaining) {
            omitted = true;
        }
    }

    const attachment = boundedAttachment("Diagnostics", lines, bindings, workspacePath, contextToken, 0, omitted);
    await validateLanguageAttachments(vscode, [attachment], workspacePath, contextToken);

    return attachment;
}

async function collectSymbolContext(vscode, { workspacePath, editor, kind, contextToken }) {
    if (!editor || !["References", "Definition"].includes(kind)) {
        throw new Error("Select a symbol in a saved workspace file first.");
    }

    const origin = await bindingFor(vscode, workspacePath, editor.document.uri);
    const position = editor.selection.active;
    if (
        !Number.isSafeInteger(position?.line) ||
        !Number.isSafeInteger(position?.character) ||
        position.line < 0 ||
        position.character < 0
    ) {
        throw new Error("Select a valid symbol position.");
    }

    let timer;
    let values;
    try {
        values = await Promise.race([
            vscode.commands.executeCommand(
                kind === "References" ? "vscode.executeReferenceProvider" : "vscode.executeDefinitionProvider",
                editor.document.uri,
                position,
            ),
            new Promise((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("Language provider timed out. No context was attached.")),
                    LANGUAGE_LIMITS.providerMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }

    if (values !== undefined && !Array.isArray(values)) {
        throw new Error("The language provider returned an unsupported result.");
    }

    values ??= [];
    const bindings = [origin];
    const lines = [`Symbol: ${bufferLabel(origin)} at ${position.line + 1}:${position.character + 1}`];
    let excluded = 0;
    let omitted = values.length > LANGUAGE_LIMITS.results;
    if (values.length === 0) {
        lines.push("No locations returned. A provider may be missing or may have no result for this symbol.");
    }

    for (const value of values.slice(0, LANGUAGE_LIMITS.results)) {
        const uri = value.uri ?? value.targetUri;
        const range = rangeLabel(value.range ?? value.targetSelectionRange ?? value.targetRange);
        if (!uri || uri.scheme !== "file" || !range) {
            excluded += 1;
            continue;
        }

        let binding = bindings.find((item) => item.filePath === uri.fsPath);
        if (!binding) {
            if (bindings.length >= LANGUAGE_LIMITS.files) {
                excluded += 1;
                omitted = true;
                continue;
            }

            try {
                binding = await bindingFor(vscode, workspacePath, uri);
                bindings.push(binding);
            } catch {
                excluded += 1;
                continue;
            }
        }

        lines.push(`${bufferLabel(binding)}:${range}`);
    }

    const attachment = boundedAttachment(kind, lines, bindings, workspacePath, contextToken, excluded, omitted);
    await validateLanguageAttachments(vscode, [attachment], workspacePath, contextToken);

    return attachment;
}

module.exports = { LANGUAGE_LIMITS, collectDiagnostics, collectSymbolContext, validateLanguageAttachments };

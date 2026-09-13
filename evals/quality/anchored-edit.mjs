import { createHash } from "node:crypto";

// Experiment only: no registration, mutation capability, filesystem access or managed installation.
// The experiment driver alone applies returned bytes within its closed disposable fixture inventory.
export const anchorDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function anchoredSnapshot(bytes) {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const bom = text.startsWith("\ufeff");
    const content = bom ? text.slice(1) : text;
    const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

    return { sha256: anchorDigest(bytes), bom, lines };
}

export function resolveAnchoredEdit(bytes, input) {
    const snapshot = anchoredSnapshot(bytes);
    if (input.sha256 !== snapshot.sha256) {
        throw new Error("Stale file snapshot; read the file again before editing.");
    }

    if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 64) {
        throw new Error("Provide one to 64 non-overlapping line replacements.");
    }

    const ending = snapshot.lines.find((line) => line.endsWith("\n"))?.endsWith("\r\n") ? "\r\n" : "\n";
    const resolved = input.edits
        .map((edit) => {
            if (
                !Number.isSafeInteger(edit.startLine) ||
                !Number.isSafeInteger(edit.endLine) ||
                edit.startLine < 1 ||
                edit.endLine < edit.startLine ||
                edit.endLine > snapshot.lines.length ||
                typeof edit.newText !== "string" ||
                /\r(?!\n)/u.test(edit.newText)
            ) {
                throw new Error("Malformed line range or replacement.");
            }

            return {
                start: edit.startLine - 1,
                end: edit.endLine,
                oldText: snapshot.lines.slice(edit.startLine - 1, edit.endLine).join(""),
                newText: edit.newText.replaceAll("\r\n", "\n").replaceAll("\n", ending),
            };
        })
        .sort((a, b) => a.start - b.start);
    for (let index = 1; index < resolved.length; index += 1) {
        if (resolved[index].start < resolved[index - 1].end) {
            throw new Error("Overlapping anchors; file left unchanged.");
        }
    }

    const parts = [];
    let cursor = 0;
    for (const edit of resolved) {
        parts.push(snapshot.lines.slice(cursor, edit.start).join(""), edit.newText);
        cursor = edit.end;
    }

    parts.push(snapshot.lines.slice(cursor).join(""));
    const result = Buffer.from(`${snapshot.bom ? "\ufeff" : ""}${parts.join("")}`);

    return { bytes: result, snapshot: snapshot.sha256 };
}

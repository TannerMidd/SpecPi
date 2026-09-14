"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { sensitivePath } = require("./context");

const MAX_REFERENCE_LENGTH = 4_096;
const MAX_POSITION = 1_000_000;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>"|?*]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;

function validPosition(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_POSITION;
}

function parseCodeReference(value) {
    if (typeof value !== "string" || !value || value.length > MAX_REFERENCE_LENGTH || UNSAFE_CHARACTERS.test(value)) {
        return null;
    }

    let reference = value.trim();
    if (!reference || UNSAFE_CHARACTERS.test(reference)) {
        return null;
    }

    const fileUrl = /^file:\/\//iu.test(reference);
    if (fileUrl) {
        // Only local, absolute file URLs are accepted. Authorities and credentials
        // are never passed to a URI opener or interpreted as network shares.
        if (!/^file:\/\/\/(?!\/)/iu.test(reference)) {
            return null;
        }

        reference = reference.slice(7);
    }

    let line = 1;
    let column = 1;
    let endLine;
    const fragment = reference.match(/#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/iu);
    const suffix = fragment ? null : reference.match(/:(\d+)(?::(\d+))?(?:-(\d+))?$/u);
    if (fragment) {
        reference = reference.slice(0, fragment.index);
        line = Number(fragment[1]);
        column = fragment[2] === undefined ? 1 : Number(fragment[2]);
        endLine = fragment[3] === undefined ? undefined : Number(fragment[3]);
        if (fragment[4] !== undefined && !validPosition(Number(fragment[4]))) {
            return null;
        }
    } else if (suffix) {
        reference = reference.slice(0, suffix.index);
        line = Number(suffix[1]);
        column = suffix[2] === undefined ? 1 : Number(suffix[2]);
        endLine = suffix[3] === undefined ? undefined : Number(suffix[3]);
    } else if (/#L\d/iu.test(reference)) {
        return null;
    }

    if (
        !validPosition(line) ||
        !validPosition(column) ||
        (endLine !== undefined && (!validPosition(endLine) || endLine < line))
    ) {
        return null;
    }

    if (fileUrl) {
        // Raw filesystem references keep literal '%' characters. Decode explicit
        // URLs exactly once, after separating their line fragment.
        if (reference.includes("#")) {
            return null;
        }

        try {
            reference = decodeURIComponent(reference);
        } catch {
            return null;
        }
    }

    reference = reference.replaceAll("\\", "/");
    if (/^\/[a-z]:\//iu.test(reference)) {
        reference = reference.slice(1);
    }

    const drivePath = /^[a-z]:\//iu.test(reference);
    const ordinaryPath = drivePath ? reference.slice(3) : reference;
    const segments = ordinaryPath.split("/");
    if (
        !reference ||
        UNSAFE_CHARACTERS.test(reference) ||
        reference.startsWith("//") ||
        ordinaryPath.includes(":") ||
        segments.some(
            (segment) =>
                WINDOWS_DEVICE.test(segment) || (segment !== "." && segment !== ".." && /[. ]$/u.test(segment)),
        )
    ) {
        return null;
    }

    return { path: reference, line, column, ...(endLine === undefined ? {} : { endLine }) };
}

function within(root, candidate) {
    const relative = path.relative(root, candidate);

    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function findShortReference(workspace, reference, findFiles) {
    const suffix = path.normalize(reference);
    const compare = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    // Search for the literal suffix through the editor's file search service.
    // Unrelated workspace entries must never consume a navigation budget.
    const literal = suffix.replaceAll(path.sep, "/").replace(/[a-zA-Z\[\]{}?,*]/gu, (character) => {
        if (process.platform === "win32" && /[a-z]/iu.test(character)) {
            return `[${character.toLowerCase()}${character.toUpperCase()}]`;
        }

        return /[\[\]{}?,*]/u.test(character) ? `[${character}]` : character;
    });
    const excluded =
        "{**/.git/**,**/node_modules/**,**/.pi/**,**/tannermidd.specpi-chat/**,**/.ssh/**,**/.gnupg/**,**/.aws/**,**/.azure/**,**/.kube/**}";
    const candidates = await findFiles(`**/${literal}`, excluded);
    let match;
    for (const uri of candidates) {
        if (
            uri?.scheme !== "file" ||
            uri.authority ||
            uri.query ||
            uri.fragment ||
            typeof uri.fsPath !== "string" ||
            !path.isAbsolute(uri.fsPath) ||
            !within(workspace, uri.fsPath)
        ) {
            continue;
        }

        const candidate = path.resolve(uri.fsPath);
        const relative = path.relative(workspace, candidate);
        if (
            !compare(relative).endsWith(compare(`${path.sep}${suffix}`)) ||
            !parseCodeReference(candidate) ||
            sensitivePath(candidate) ||
            /(?:^|[/\\])(?:\.git|node_modules|\.pi|tannermidd\.specpi-chat)(?:[/\\]|$)/iu.test(candidate)
        ) {
            continue;
        }

        // Search results are only hints. Reject symlink components before the
        // existing canonical containment, private-path, and hard-link checks.
        let current = workspace;
        let linked = false;
        for (const segment of relative.split(path.sep)) {
            current = path.join(current, segment);
            if ((await fs.lstat(current)).isSymbolicLink()) {
                linked = true;
                break;
            }
        }

        if (linked || !(await fs.stat(candidate)).isFile()) {
            continue;
        }

        if (match && compare(match) !== compare(candidate)) {
            throw new Error(
                "This shortened reference matches multiple workspace files. Use its full workspace-relative path.",
            );
        }

        match = candidate;
    }

    return match;
}

async function resolveCodeReference({ workspacePath, reference, findFiles }) {
    const parsed = parseCodeReference(reference);
    if (!parsed) {
        throw new Error("This is not a supported workspace file reference.");
    }

    if (typeof workspacePath !== "string" || !workspacePath || !path.isAbsolute(workspacePath)) {
        throw new Error("Open a local workspace before opening a code reference.");
    }

    // A Windows absolute path must never become a relative filename on another OS.
    if (process.platform !== "win32" && /^[a-z]:\//iu.test(parsed.path)) {
        throw new Error("This file reference belongs to a different operating system.");
    }

    const workspace = path.resolve(workspacePath);
    let selectedPath = path.resolve(workspace, parsed.path);
    if (!within(workspace, selectedPath)) {
        throw new Error("Code references must be inside the selected workspace.");
    }

    if (sensitivePath(selectedPath)) {
        throw new Error(
            "Private credentials and Pi authentication, trust, sessions, missions, or history cannot be opened from chat.",
        );
    }

    let canonicalWorkspace;
    let canonicalFile;
    let info;
    try {
        canonicalWorkspace = await fs.realpath(workspace);
    } catch {
        throw new Error("This workspace is unavailable. Check that it is accessible.");
    }

    try {
        canonicalFile = await fs.realpath(selectedPath);
    } catch (error) {
        if (
            error.code === "ENOENT" &&
            typeof findFiles === "function" &&
            !path.isAbsolute(parsed.path) &&
            !parsed.path.split("/").includes("..")
        ) {
            selectedPath = await findShortReference(workspace, parsed.path, findFiles);
        } else {
            throw new Error("This workspace file is unavailable. Check its path and access permissions.");
        }

        if (!selectedPath) {
            throw new Error(
                "This workspace file is unavailable. No file matches this link; check its spelling and path.",
            );
        }

        canonicalFile = await fs.realpath(selectedPath);
    }

    if (!within(canonicalWorkspace, canonicalFile)) {
        throw new Error("This file resolves outside the workspace and cannot be opened from chat.");
    }

    if (sensitivePath(canonicalFile)) {
        throw new Error(
            "Private credentials and Pi authentication, trust, sessions, missions, or history cannot be opened from chat.",
        );
    }

    try {
        info = await fs.stat(canonicalFile);
        if (!info.isFile()) {
            throw new Error("Only regular workspace files can be opened from chat.");
        }

        if (info.nlink !== 1) {
            throw new Error("Files with hard links cannot be safely opened from chat.");
        }

        const currentPath = await fs.realpath(selectedPath);
        const currentInfo = await fs.stat(currentPath);
        if (currentPath !== canonicalFile || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) {
            throw new Error("The referenced file changed. Click its reference again.");
        }
    } catch (error) {
        if (error?.code) {
            throw new Error("This workspace file could not be opened safely. Check that it is available.");
        }

        throw error;
    }

    return { ...parsed, path: canonicalFile };
}

module.exports = { parseCodeReference, resolveCodeReference };

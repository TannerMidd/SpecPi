import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export function pathIdentity(value: string, platform: NodeJS.Platform = process.platform): string {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const normalized = pathApi.normalize(pathApi.resolve(value));

    return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function displayNativePath(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, (character) => {
        if (character === "\n") {
            return "\\n";
        }

        if (character === "\r") {
            return "\\r";
        }

        if (character === "\t") {
            return "\\t";
        }

        return `\\u{${character.codePointAt(0)?.toString(16) ?? "?"}}`;
    });
}

export async function canonicalPath(value: string): Promise<string> {
    return realpath(path.resolve(value));
}

/**
 * Pi assigns a persistent session path before its first entry creates the JSONL leaf.
 * Canonicalize that reserved reference through its existing parent without accepting
 * an existing unresolved leaf such as a dangling symlink.
 */
export async function canonicalSessionPath(value: string): Promise<string> {
    const absolute = path.resolve(value);
    let missingLeafError: unknown;
    try {
        return await realpath(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }

        missingLeafError = error;
    }

    const parent = await realpath(path.dirname(absolute));
    const candidate = path.join(parent, path.basename(absolute));
    try {
        await lstat(candidate);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return candidate;
        }

        throw error;
    }

    throw missingLeafError;
}

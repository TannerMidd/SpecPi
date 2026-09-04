import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileNode, FilePreview } from "../shared/domain";

const MAX_ENTRIES = 2_000;
const HEAVY_DIRECTORIES = new Set([".git", "node_modules", "dist", "out", "coverage", ".next"]);
const MAX_PREVIEW_BYTES = 512 * 1024;
const IMAGE_MIME = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
]);

function within(root: string, target: string): boolean {
    const relative = path.relative(root, target);

    return (
        relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
}

async function resolveInsideRoot(projectRoot: string, relativePath: string): Promise<{ root: string; target: string }> {
    const root = await realpath(path.resolve(projectRoot));
    const lexical = path.resolve(root, relativePath || ".");
    if (!within(root, lexical)) {
        throw new Error("Path is outside the selected project");
    }

    const target = await realpath(lexical);
    if (!within(root, target)) {
        throw new Error("Symlink target is outside the selected project");
    }

    return { root, target };
}

export async function listDirectory(projectRoot: string, relativePath: string): Promise<FileNode[]> {
    const { root, target } = await resolveInsideRoot(projectRoot, relativePath);
    const entries = (await readdir(target, { withFileTypes: true })).filter(
        (entry) => !(entry.isDirectory() && HEAVY_DIRECTORIES.has(entry.name)),
    );
    if (entries.length > MAX_ENTRIES) {
        throw new Error(`Directory exceeds the ${MAX_ENTRIES} entry display limit`);
    }

    const nodes = await Promise.all(
        entries.map(async (entry): Promise<FileNode> => {
            const absolute = path.join(target, entry.name);
            const stats = await lstat(absolute);
            const relative = path.relative(root, absolute).split(path.sep).join("/");
            if (entry.isSymbolicLink()) {
                return { name: entry.name, relativePath: relative, kind: "symlink" };
            }

            if (entry.isDirectory()) {
                return { name: entry.name, relativePath: relative, kind: "directory" };
            }

            return { name: entry.name, relativePath: relative, kind: "file", size: stats.size };
        }),
    );

    return nodes.sort((left, right) => {
        if (left.kind === "directory" && right.kind !== "directory") {
            return -1;
        }

        if (right.kind === "directory" && left.kind !== "directory") {
            return 1;
        }

        return left.name.localeCompare(right.name);
    });
}

function appearsBinary(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));

    return sample.includes(0);
}

export async function previewFile(projectRoot: string, relativePath: string): Promise<FilePreview> {
    const { root, target } = await resolveInsideRoot(projectRoot, relativePath);
    const stats = await lstat(target);
    if (!stats.isFile()) {
        throw new Error("Only regular files can be previewed");
    }

    const extension = path.extname(target).toLowerCase();
    const mimeType = IMAGE_MIME.get(extension);
    const imageLimit = 10 * 1024 * 1024;
    const readLimit = mimeType ? imageLimit + 1 : MAX_PREVIEW_BYTES + 1;
    const data = Buffer.alloc(Math.min(stats.size, readLimit));
    const handle = await open(target, "r");
    try {
        await handle.read(data, 0, data.length, 0);
    } finally {
        await handle.close();
    }

    const relative = path.relative(root, target).split(path.sep).join("/");
    if (mimeType && stats.size <= imageLimit) {
        return {
            relativePath: relative,
            kind: "image",
            dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
            truncated: false,
            size: stats.size,
            mimeType,
        };
    }

    if (appearsBinary(data)) {
        return { relativePath: relative, kind: "binary", truncated: false, size: stats.size };
    }

    let preview: string;
    try {
        preview = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, MAX_PREVIEW_BYTES), {
            stream: data.length < stats.size,
        });
    } catch {
        return { relativePath: relative, kind: "binary", truncated: false, size: stats.size };
    }

    return {
        relativePath: relative,
        kind: "text",
        content: preview,
        truncated: data.length > MAX_PREVIEW_BYTES,
        size: stats.size,
    };
}

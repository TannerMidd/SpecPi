import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listDirectory, previewFile } from "../../src/main/file-service";

async function fixture(): Promise<string> {
    const root = path.join(os.tmpdir(), `specpi-files-${crypto.randomUUID()}`);
    await mkdir(path.join(root, "folder"), { recursive: true });
    await writeFile(path.join(root, "plain.txt"), "hello");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, "vector.svg"), '<svg onload="alert(1)"></svg>');

    return root;
}

describe("project file service", () => {
    it("sorts directories first and classifies bounded previews", async () => {
        const root = await fixture();
        expect((await listDirectory(root, "")).map((item) => item.name)).toEqual([
            "folder",
            "binary.dat",
            "plain.txt",
            "vector.svg",
        ]);
        expect(await previewFile(root, "plain.txt")).toMatchObject({ kind: "text", content: "hello" });
        expect(await previewFile(root, "binary.dat")).toMatchObject({ kind: "binary" });
        expect(await previewFile(root, "vector.svg")).toMatchObject({ kind: "text" });
    });

    it("bounds large text reads", async () => {
        const root = await fixture();
        await writeFile(path.join(root, "large.txt"), "a".repeat(600 * 1024));
        const preview = await previewFile(root, "large.txt");
        expect(preview.kind).toBe("text");
        expect(preview.truncated).toBe(true);
        expect(preview.content).toHaveLength(512 * 1024);
    });

    it("rejects traversal and symlink escapes", async () => {
        const root = await fixture();
        await expect(previewFile(root, "../outside.txt")).rejects.toThrow("outside");
        const outside = path.join(os.tmpdir(), `specpi-outside-${crypto.randomUUID()}.txt`);
        await writeFile(outside, "private");
        try {
            await symlink(outside, path.join(root, "escape.txt"), "file");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") {
                return;
            }

            throw error;
        }

        await expect(previewFile(root, "escape.txt")).rejects.toThrow("outside");
    });
});

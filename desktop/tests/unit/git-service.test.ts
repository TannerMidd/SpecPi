import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parsePorcelainStatus, readGitStatus } from "../../src/main/git-service";

const execute = promisify(execFile);

describe("Git porcelain parser", () => {
    it("[C9] keeps rename and copy destinations while consuming their source records", () => {
        const result = parsePorcelainStatus(
            "## feature\0R  new name.txt\0old name.txt\0C  copied.txt\0source.txt\0 M ordinary.txt\0?? untracked.txt\0",
        );

        expect(result.branch).toBe("feature");
        expect(result.files).toEqual([
            { path: "new name.txt", originalPath: "old name.txt", index: "R", worktree: " " },
            { path: "copied.txt", originalPath: "source.txt", index: "C", worktree: " " },
            { path: "ordinary.txt", index: " ", worktree: "M" },
            { path: "untracked.txt", index: "?", worktree: "?" },
        ]);
    });

    it("[C9] preserves NUL-framed filenames containing newlines", () => {
        const result = parsePorcelainStatus("## main\0 M line one\nline two.txt\0");

        expect(result.files[0]?.path).toBe("line one\nline two.txt");
    });

    it("[C9] reports the destination from a real staged rename", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "specpi-git-rename-"));
        try {
            await execute("git", ["init"], { cwd: root });
            await execute("git", ["config", "user.email", "specpi@example.invalid"], { cwd: root });
            await execute("git", ["config", "user.name", "SpecPi Test"], { cwd: root });
            await writeFile(path.join(root, "old name.txt"), "rename fixture\n");
            await execute("git", ["add", "old name.txt"], { cwd: root });
            await execute("git", ["commit", "-m", "fixture"], { cwd: root });
            await rename(path.join(root, "old name.txt"), path.join(root, "new name.txt"));
            await execute("git", ["add", "-A"], { cwd: root });

            const result = await readGitStatus(root);

            expect(result.files).toContainEqual({
                path: "new name.txt",
                originalPath: "old name.txt",
                index: "R",
                worktree: " ",
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

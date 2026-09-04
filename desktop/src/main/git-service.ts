import { spawn } from "node:child_process";
import path from "node:path";
import type { GitFileStatus, GitStatus } from "../shared/domain";

const MAX_OUTPUT = 2 * 1024 * 1024;

async function git(
    cwd: string,
    args: string[],
    timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Git operation timed out"));
        }, timeoutMs);
        const append = (current: Buffer, chunk: Buffer) => {
            const combined = Buffer.concat([current, chunk]);
            if (combined.length > MAX_OUTPUT) {
                child.kill();
                throw new Error("Git output exceeded the display limit");
            }

            return combined;
        };

        child.stdout.on("data", (chunk: Buffer) => {
            try {
                stdout = append(stdout, chunk);
            } catch (error) {
                reject(error);
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            try {
                stderr = append(stderr, chunk);
            } catch (error) {
                reject(error);
            }
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
        });
    });
}

export function parsePorcelainStatus(output: string): Pick<GitStatus, "branch" | "files"> {
    const records = output.split("\0").filter(Boolean);
    const branchRecord = records[0]?.startsWith("## ") ? records.shift() : undefined;
    const branch = branchRecord?.slice(3);
    const files: GitFileStatus[] = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record || record.length < 4) {
            continue;
        }

        const status = record.slice(0, 2);
        const filePath = record.slice(3);
        let originalPath: string | undefined;
        if (status.includes("R") || status.includes("C")) {
            originalPath = records[index + 1];
            index += 1;
        }

        files.push({
            path: filePath,
            ...(originalPath ? { originalPath } : {}),
            index: status[0] ?? " ",
            worktree: status[1] ?? " ",
        });
    }

    return { branch, files };
}

export async function readGitStatus(projectRoot: string): Promise<GitStatus> {
    try {
        const root = path.resolve(projectRoot);
        const result = await git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]);
        if (result.code !== 0) {
            return { available: false, files: [], error: result.stderr.trim() || "Not a Git repository" };
        }

        return { available: true, ...parsePorcelainStatus(result.stdout) };
    } catch (error) {
        return { available: false, files: [], error: error instanceof Error ? error.message : String(error) };
    }
}

export async function readGitDiff(projectRoot: string, relativePath?: string): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--no-color", "--"];
    if (relativePath) {
        args.push(relativePath);
    }

    const result = await git(path.resolve(projectRoot), args);
    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "Git diff failed");
    }

    return result.stdout;
}

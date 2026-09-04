import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
    lstat: vi.fn(),
    realpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => filesystem);

import { canonicalPath, canonicalSessionPath } from "../../src/main/path-identity";

function filesystemError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
}

describe("main-process path identity", () => {
    beforeEach(() => {
        filesystem.lstat.mockReset();
        filesystem.realpath.mockReset();
    });

    it("keeps ordinary canonical paths strict when the leaf is missing", async () => {
        const missing = filesystemError("ENOENT");
        filesystem.realpath.mockRejectedValueOnce(missing);

        await expect(canonicalPath("missing-project")).rejects.toBe(missing);
        expect(filesystem.realpath).toHaveBeenCalledOnce();
        expect(filesystem.realpath).toHaveBeenCalledWith(path.resolve("missing-project"));
        expect(filesystem.lstat).not.toHaveBeenCalled();
    });

    it("uses the full realpath for an existing session leaf", async () => {
        filesystem.realpath.mockResolvedValueOnce("canonical-session.jsonl");

        await expect(canonicalSessionPath("session.jsonl")).resolves.toBe("canonical-session.jsonl");
        expect(filesystem.realpath).toHaveBeenCalledOnce();
        expect(filesystem.lstat).not.toHaveBeenCalled();
    });

    it("canonicalizes a Pi-reserved missing leaf through its existing parent", async () => {
        const missingLeaf = filesystemError("ENOENT");
        const canonicalParent = path.resolve("canonical-sessions");
        const candidate = path.join(canonicalParent, "future.jsonl");
        filesystem.realpath.mockRejectedValueOnce(missingLeaf).mockResolvedValueOnce(canonicalParent);
        filesystem.lstat.mockRejectedValueOnce(filesystemError("ENOENT"));

        await expect(canonicalSessionPath(path.join("sessions", "future.jsonl"))).resolves.toBe(candidate);
        expect(filesystem.lstat).toHaveBeenCalledWith(candidate);
    });

    it("rejects a session reference whose parent is also missing", async () => {
        const missingLeaf = filesystemError("ENOENT");
        const missingParent = filesystemError("ENOENT");
        filesystem.realpath.mockRejectedValueOnce(missingLeaf).mockRejectedValueOnce(missingParent);

        await expect(canonicalSessionPath(path.join("missing", "future.jsonl"))).rejects.toBe(missingParent);
        expect(filesystem.lstat).not.toHaveBeenCalled();
    });

    it("rejects an existing unresolved leaf such as a dangling symlink", async () => {
        const missingTarget = filesystemError("ENOENT");
        const canonicalParent = path.resolve("canonical-sessions");
        filesystem.realpath.mockRejectedValueOnce(missingTarget).mockResolvedValueOnce(canonicalParent);
        filesystem.lstat.mockResolvedValueOnce({});

        await expect(canonicalSessionPath(path.join("sessions", "dangling.jsonl"))).rejects.toBe(missingTarget);
    });

    it("propagates non-missing full-path and leaf errors", async () => {
        const denied = filesystemError("EACCES");
        filesystem.realpath.mockRejectedValueOnce(denied);
        await expect(canonicalSessionPath("denied.jsonl")).rejects.toBe(denied);
        expect(filesystem.realpath).toHaveBeenCalledOnce();

        filesystem.realpath.mockReset();
        filesystem.realpath
            .mockRejectedValueOnce(filesystemError("ENOENT"))
            .mockResolvedValueOnce(path.resolve("canonical-sessions"));
        const leafDenied = filesystemError("EACCES");
        filesystem.lstat.mockRejectedValueOnce(leafDenied);
        await expect(canonicalSessionPath(path.join("sessions", "denied.jsonl"))).rejects.toBe(leafDenied);
    });
});

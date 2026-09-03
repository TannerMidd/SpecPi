import { useEffect, useState } from "react";
import type { FileNode, FilePreview, GitStatus } from "../../../shared/domain";
import { Markdown } from "./Markdown";

function FileList({ root, directory, select }: { root: string; directory: string; select(path: string): void }) {
    const [nodes, setNodes] = useState<FileNode[]>([]);
    const [open, setOpen] = useState(new Set<string>());
    useEffect(() => {
        void window.specpi
            .listDirectory(root, directory)
            .then(setNodes)
            .catch(() => setNodes([]));
    }, [root, directory]);

    return (
        <ul className="file-list">
            {nodes.map((node) => (
                <li key={node.relativePath}>
                    {node.kind === "directory" ? (
                        <>
                            <button
                                onClick={() =>
                                    setOpen((current) => {
                                        const next = new Set(current);
                                        if (next.has(node.relativePath)) {
                                            next.delete(node.relativePath);
                                        } else {
                                            next.add(node.relativePath);
                                        }

                                        return next;
                                    })
                                }
                            >
                                {open.has(node.relativePath) ? "▾" : "▸"} {node.name}
                            </button>
                            {open.has(node.relativePath) ? (
                                <FileList root={root} directory={node.relativePath} select={select} />
                            ) : null}
                        </>
                    ) : (
                        <button onClick={() => select(node.relativePath)}>
                            {node.kind === "symlink" ? "↗" : "·"} {node.name}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

export function FilesPanel({
    root,
    tab,
    setTab,
    close,
    sendComment,
    refreshToken,
    onGitStatus,
}: {
    root: string;
    tab: "files" | "changes";
    setTab(tab: "files" | "changes"): void;
    close(): void;
    sendComment(message: string): void;
    refreshToken: number;
    onGitStatus(status: GitStatus): void;
}) {
    const [preview, setPreview] = useState<FilePreview>();
    const [git, setGit] = useState<GitStatus>();
    const [diff, setDiff] = useState("");
    const [lineStart, setLineStart] = useState(1);
    const [lineEnd, setLineEnd] = useState(1);
    const [error, setError] = useState("");
    const select = async (relativePath: string) => {
        setError("");
        try {
            setPreview(await window.specpi.readFile(root, relativePath));
            setDiff("");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const refreshGit = async () => {
        const status = await window.specpi.getGitStatus(root);
        setGit(status);
        onGitStatus(status);
    };

    useEffect(() => {
        const timer = setTimeout(() => void refreshGit(), 250);

        return () => clearTimeout(timer);
    }, [root, refreshToken]);

    return (
        <aside className="files-panel">
            <header>
                <div className="tabs">
                    <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
                        Files
                    </button>
                    <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
                        Changes {git?.files.length ? `(${git.files.length})` : ""}
                    </button>
                </div>
                <button aria-label="Close files" onClick={close}>
                    ×
                </button>
            </header>
            <div className="files-body">
                <nav>
                    {git?.branch ? (
                        <div className="git-summary">
                            <span>{git.branch}</span>
                            <span>{git.files.length} changed</span>
                        </div>
                    ) : null}
                    {tab === "files" ? (
                        <FileList root={root} directory="" select={(path) => void select(path)} />
                    ) : (
                        <div className="changes-list">
                            <button onClick={() => void refreshGit()}>Refresh</button>
                            {git?.files.map((file) => (
                                <button
                                    key={file.path}
                                    onClick={async () => {
                                        setPreview(undefined);
                                        setDiff(await window.specpi.getGitDiff(root, file.path));
                                    }}
                                >
                                    <code>
                                        {file.index}
                                        {file.worktree}
                                    </code>{" "}
                                    {file.path}
                                </button>
                            ))}
                            {git && !git.available ? <p>{git.error}</p> : null}
                        </div>
                    )}
                </nav>
                <section className="preview">
                    {error ? <p className="error">{error}</p> : null}
                    {diff ? <pre className="diff">{diff || "No unstaged diff"}</pre> : null}
                    {preview?.kind === "image" ? <img src={preview.dataUrl} alt={preview.relativePath} /> : null}
                    {preview?.kind === "binary" ? <p>Binary preview is unavailable.</p> : null}
                    {preview?.kind === "text" ? (
                        <>
                            {/\.md(?:own)?$/iu.test(preview.relativePath) ? (
                                <Markdown content={preview.content ?? ""} />
                            ) : (
                                <pre>{preview.content}</pre>
                            )}
                            {preview.truncated ? <p>Preview truncated.</p> : null}
                            <div className="line-range">
                                <label>
                                    From line{" "}
                                    <input
                                        type="number"
                                        min="1"
                                        value={lineStart}
                                        onChange={(event) => setLineStart(Math.max(1, Number(event.target.value)))}
                                    />
                                </label>
                                <label>
                                    to{" "}
                                    <input
                                        type="number"
                                        min={lineStart}
                                        value={lineEnd}
                                        onChange={(event) =>
                                            setLineEnd(Math.max(lineStart, Number(event.target.value)))
                                        }
                                    />
                                </label>
                            </div>
                            <div className="preview-actions">
                                <button onClick={() => window.specpi.copyText(preview.relativePath)}>Copy path</button>
                                <button
                                    onClick={() =>
                                        sendComment(
                                            `Review ${preview.relativePath}:${lineStart}-${Math.max(lineStart, lineEnd)} and address the following comment:\n`,
                                        )
                                    }
                                >
                                    Send review comment
                                </button>
                            </div>
                        </>
                    ) : null}
                </section>
            </div>
        </aside>
    );
}

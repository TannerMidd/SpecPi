import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileNode, FilePreview, GitFileStatus, GitStatus } from "../../../shared/domain";
import { parseDiff } from "../lib/diff";
import { Icon } from "./Icons";
import { Markdown } from "./Markdown";

function statusLetter(file?: GitFileStatus): string {
    return file ? file.worktree.trim() || file.index.trim() || "·" : "file";
}

function statusLabel(file?: GitFileStatus): string {
    if (!file) {
        return "File";
    }

    const letter = statusLetter(file);
    const labels: Record<string, string> = {
        A: "Added",
        D: "Deleted",
        M: "Modified",
        R: "Renamed",
        "?": "Untracked",
    };

    return labels[letter] ?? "Changed";
}

function FileList({
    root,
    directory,
    selected,
    select,
}: {
    root: string;
    directory: string;
    selected?: string;
    select(path: string): void;
}) {
    const [nodes, setNodes] = useState<FileNode[]>([]);
    const [open, setOpen] = useState(new Set<string>());
    useEffect(() => {
        let active = true;
        void window.specpi
            .listDirectory(root, directory)
            .then((value) => active && setNodes(value))
            .catch(() => active && setNodes([]));

        return () => {
            active = false;
        };
    }, [root, directory]);

    return (
        <ul className="file-list">
            {nodes.map((node) => (
                <li key={node.relativePath}>
                    {node.kind === "directory" ? (
                        <>
                            <button
                                className="directory-row"
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
                                <Icon name={open.has(node.relativePath) ? "chevron-down" : "chevron-right"} size={12} />
                                <span>{node.name}</span>
                            </button>
                            {open.has(node.relativePath) ? (
                                <FileList
                                    root={root}
                                    directory={node.relativePath}
                                    selected={selected}
                                    select={select}
                                />
                            ) : null}
                        </>
                    ) : (
                        <button
                            className={selected === node.relativePath ? "active" : ""}
                            onClick={() => select(node.relativePath)}
                        >
                            <span className="file-glyph">{node.kind === "symlink" ? "↗" : "·"}</span>
                            <span>{node.name}</span>
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

function DiffView({
    diff,
    lineStart,
    lineEnd,
    selectLine,
}: {
    diff: string;
    lineStart: number;
    lineEnd: number;
    selectLine(line: number, extend: boolean): void;
}) {
    const lines = useMemo(() => parseDiff(diff).filter((line) => line.kind !== "meta"), [diff]);
    const additions = lines.filter((line) => line.kind === "add").length;
    const removals = lines.filter((line) => line.kind === "remove").length;

    if (!diff) {
        return (
            <div className="preview-empty">
                <p>No unstaged diff is available for this file.</p>
            </div>
        );
    }

    return (
        <div className="diff-view" role="table" aria-label="Git diff">
            {lines.map((line) => {
                if (line.kind === "hunk") {
                    return (
                        <div className="diff-hunk" key={line.key}>
                            <span>{line.content}</span>
                            <span className="diff-totals">
                                <i className="added">+{additions}</i>
                                <i className="removed">−{removals}</i>
                            </span>
                        </div>
                    );
                }

                const reviewLine = line.newLine ?? line.oldLine;
                const selected = reviewLine !== undefined && reviewLine >= lineStart && reviewLine <= lineEnd;

                return (
                    <button
                        className={`diff-line ${line.kind}${selected ? " selected" : ""}`}
                        key={line.key}
                        disabled={reviewLine === undefined}
                        onClick={(event) => reviewLine !== undefined && selectLine(reviewLine, event.shiftKey)}
                    >
                        <span className="old-line">{line.oldLine ?? ""}</span>
                        <span className="new-line">{line.newLine ?? ""}</span>
                        <code>{line.content || " "}</code>
                    </button>
                );
            })}
        </div>
    );
}

export function FilesPanel({
    open,
    root,
    tab,
    setTab: _setTab,
    close,
    sendComment,
    refreshToken,
    onGitStatus,
}: {
    open: boolean;
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
    const [selectedPath, setSelectedPath] = useState<string>();
    const [selectedChange, setSelectedChange] = useState<GitFileStatus>();
    const [view, setView] = useState<"preview" | "diff">(tab === "changes" ? "diff" : "preview");
    const [lineStart, setLineStart] = useState(1);
    const [lineEnd, setLineEnd] = useState(1);
    const [error, setError] = useState("");

    const selectFile = useCallback(
        async (relativePath: string) => {
            setError("");
            setSelectedPath(relativePath);
            setSelectedChange(git?.files.find((file) => file.path === relativePath));
            setView("preview");
            try {
                setPreview(await window.specpi.readFile(root, relativePath));
                setDiff("");
            } catch (caught) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        },
        [git?.files, root],
    );

    const selectChangeFile = useCallback(
        async (file: GitFileStatus) => {
            setError("");
            setPreview(undefined);
            setSelectedPath(file.path);
            setSelectedChange(file);
            setLineStart(1);
            setLineEnd(1);
            setView("diff");
            try {
                const nextDiff = await window.specpi.getGitDiff(root, file.path);
                const firstLine = parseDiff(nextDiff).find(
                    (line) => line.newLine !== undefined || line.oldLine !== undefined,
                );
                const line = firstLine?.newLine ?? firstLine?.oldLine ?? 1;
                setDiff(nextDiff);
                setLineStart(line);
                setLineEnd(line);
            } catch (caught) {
                setDiff("");
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        },
        [root],
    );

    const refreshGit = useCallback(async () => {
        const status = await window.specpi.getGitStatus(root);
        setGit(status);
        onGitStatus(status);

        return status;
    }, [onGitStatus, root]);

    useEffect(() => {
        if (tab === "files") {
            setView("preview");
            if (selectedPath) {
                void selectFile(selectedPath);
            }
        }
    }, [tab]);

    useEffect(() => {
        const timer = setTimeout(() => {
            void refreshGit()
                .then((status) => {
                    if (tab === "changes" && status.files.length > 0) {
                        const next = status.files.find((file) => file.path === selectedPath) ?? status.files[0];
                        if (next) {
                            void selectChangeFile(next);
                        }
                    }
                })
                .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
        }, 150);

        return () => clearTimeout(timer);
    }, [root, refreshToken, tab]);

    const lineLabel = lineStart === lineEnd ? `line ${lineStart}` : `lines ${lineStart}–${lineEnd}`;
    const reviewSelection = () => {
        if (!selectedPath) {
            return;
        }

        sendComment(
            `Review ${selectedPath}:${lineStart}-${Math.max(lineStart, lineEnd)} and address the following comment:\n`,
        );
    };

    return (
        <aside className={`files-panel${open ? "" : " collapsed"}`} aria-hidden={!open} inert={open ? undefined : true}>
            <header>
                <div className="file-heading">
                    <strong title={selectedPath}>
                        {selectedPath ?? (tab === "changes" ? "Working tree" : "Project files")}
                    </strong>
                    {selectedPath ? (
                        <span className={`file-status status-${statusLetter(selectedChange)}`}>
                            {statusLabel(selectedChange)}
                        </span>
                    ) : null}
                </div>
                <div className="file-header-actions">
                    {selectedPath ? (
                        <>
                            <button onClick={() => void window.specpi.copyText(selectedPath)}>Copy path</button>
                            <button className="review-lines" onClick={reviewSelection}>
                                Review {lineLabel}
                            </button>
                        </>
                    ) : null}
                    <button className="close-files" aria-label="Close files" onClick={close}>
                        <Icon name="close" size={14} />
                    </button>
                </div>
            </header>
            <div className="files-body">
                <nav>
                    {tab === "files" ? (
                        <>
                            <div className="file-nav-heading">
                                <span>Project files</span>
                            </div>
                            <FileList
                                root={root}
                                directory=""
                                selected={selectedPath}
                                select={(path) => void selectFile(path)}
                            />
                        </>
                    ) : (
                        <div className="changes-list">
                            <div className="file-nav-heading">
                                <span>Working tree</span>
                                <span>{git?.files.length ?? 0}</span>
                            </div>
                            {git?.files.map((file) => (
                                <button
                                    className={selectedPath === file.path ? "active" : ""}
                                    key={file.path}
                                    onClick={() => void selectChangeFile(file)}
                                >
                                    <code className={`status-${statusLetter(file)}`}>{statusLetter(file)}</code>
                                    <span title={file.path}>{file.path}</span>
                                </button>
                            ))}
                            {git && !git.available ? <p>{git.error}</p> : null}
                            {git?.available && git.files.length === 0 ? <p>Working tree clean.</p> : null}
                        </div>
                    )}
                </nav>
                <section className={`preview ${view}`}>
                    {error ? <p className="error">{error}</p> : null}
                    {view === "diff" ? (
                        <DiffView
                            diff={diff}
                            lineStart={lineStart}
                            lineEnd={lineEnd}
                            selectLine={(line, extend) => {
                                if (extend) {
                                    setLineStart((start) => Math.min(start, line));
                                    setLineEnd((end) => Math.max(end, line));
                                } else {
                                    setLineStart(line);
                                    setLineEnd(line);
                                }
                            }}
                        />
                    ) : null}
                    {view === "preview" && !preview && !error ? (
                        <div className="preview-empty">
                            <p>Select a file to preview it.</p>
                        </div>
                    ) : null}
                    {view === "preview" && preview?.kind === "image" ? (
                        <img src={preview.dataUrl} alt={preview.relativePath} />
                    ) : null}
                    {view === "preview" && preview?.kind === "binary" ? (
                        <div className="preview-empty">
                            <p>Binary preview is unavailable.</p>
                        </div>
                    ) : null}
                    {view === "preview" && preview?.kind === "text" ? (
                        <>
                            {/\.md(?:own)?$/iu.test(preview.relativePath) ? (
                                <Markdown content={preview.content ?? ""} />
                            ) : (
                                <pre>{preview.content}</pre>
                            )}
                            {preview.truncated ? <p className="preview-note">Preview truncated.</p> : null}
                        </>
                    ) : null}
                </section>
            </div>
        </aside>
    );
}

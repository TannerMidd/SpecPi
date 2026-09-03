import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { contentBlocks, imageSource, type ContentBlock } from "../lib/content-blocks";
import { safeJson, stripAnsi } from "../lib/text";
import type { ConversationState, TranscriptItem } from "../state/conversation";
import { contentText } from "../state/conversation";
import { Markdown } from "./Markdown";

const ContentBlocks = memo(function ContentBlocks({
    blocks,
    collapseThinking,
    imageLabel,
}: {
    blocks: ContentBlock[];
    collapseThinking: boolean;
    imageLabel: string;
}) {
    return blocks.map((block, index) => {
        if (block.type === "thinking" && typeof block.thinking === "string") {
            return (
                <details key={index} className="thinking" open={!collapseThinking}>
                    <summary>Reasoning</summary>
                    <Markdown content={stripAnsi(block.thinking)} />
                </details>
            );
        }

        if (block.type === "text" && typeof block.text === "string") {
            return <Markdown key={index} content={stripAnsi(block.text)} />;
        }

        const source = imageSource(block);
        if (source) {
            const alt = typeof block.alt === "string" ? block.alt : imageLabel;

            return (
                <figure className="content-image" key={index}>
                    <img src={source} alt={alt} loading="lazy" />
                </figure>
            );
        }

        return null;
    });
});

function toolMetadata(content: unknown): unknown {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
        return undefined;
    }

    const { content: _content, ...metadata } = content as ContentBlock;

    return Object.keys(metadata).length > 0 ? metadata : undefined;
}

const ToolCard = memo(function ToolCard({ item }: { item: TranscriptItem }) {
    const [open, setOpen] = useState(false);
    const blocks = contentBlocks(item.content);
    const metadata = blocks ? toolMetadata(item.content) : undefined;

    return (
        <article className={`tool-card ${item.status ?? ""}`}>
            <button className="tool-heading" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
                <span className="tool-dot" />
                <strong>{item.title}</strong>
                <span>{item.status}</span>
                <span className="chevron">{open ? "−" : "+"}</span>
            </button>
            {open ? (
                blocks ? (
                    <div className="tool-output">
                        <ContentBlocks
                            blocks={blocks}
                            collapseThinking={false}
                            imageLabel={`${item.title ?? "Tool"} output`}
                        />
                        {metadata ? <pre>{safeJson(metadata)}</pre> : null}
                    </div>
                ) : (
                    <pre>{safeJson(item.content)}</pre>
                )
            ) : null}
        </article>
    );
});

const Message = memo(function Message({ item, collapseThinking }: { item: TranscriptItem; collapseThinking: boolean }) {
    const content = item.content;
    const blocks = contentBlocks(content);
    const copyText = contentText(content);

    return (
        <article className={`message ${item.role}`}>
            {blocks ? (
                <ContentBlocks
                    blocks={blocks}
                    collapseThinking={collapseThinking}
                    imageLabel={item.role === "user" ? "User attachment" : "Assistant image"}
                />
            ) : (
                <Markdown content={copyText} />
            )}
            {copyText ? (
                <button className="copy-message" onClick={() => void window.specpi.copyText(copyText)}>
                    Copy
                </button>
            ) : null}
        </article>
    );
});

const EntryCard = memo(function EntryCard({ item }: { item: TranscriptItem }) {
    const data = item.content as Record<string, unknown> | undefined;
    const markdown = typeof data?.markdown === "string" ? data.markdown : undefined;

    return (
        <article className="entry-card">
            <strong>{item.title}</strong>
            {markdown ? (
                <Markdown content={markdown} />
            ) : (
                <details>
                    <summary>Details</summary>
                    <pre>{safeJson(item.content)}</pre>
                </details>
            )}
        </article>
    );
});

const StreamingResponse = memo(function StreamingResponse({
    streaming,
    specMode,
}: {
    streaming: NonNullable<ConversationState["streaming"]>;
    specMode: boolean;
}) {
    const hasHeldText = specMode && streaming.blocks.some((block) => block.type === "text" && block.text);

    return (
        <article className="message assistant streaming">
            {streaming.blocks.map((block, index) => {
                if (block.type === "thinking") {
                    return (
                        <details key={index} className="thinking" open={!specMode}>
                            <summary>Reasoning · streaming</summary>
                            <div className="streaming-copy">{stripAnsi(block.text)}</div>
                        </details>
                    );
                }

                if (block.type === "tool") {
                    return (
                        <div className="streaming-tool" key={index} role="status">
                            <span aria-hidden="true" />
                            <strong>{block.text || "Preparing tool call…"}</strong>
                        </div>
                    );
                }

                return specMode ? null : (
                    <div className="streaming-copy" key={index}>
                        {stripAnsi(block.text)}
                        <span className="streaming-caret" aria-hidden="true" />
                    </div>
                );
            })}
            {hasHeldText ? <div className="held-output">Response held until complete</div> : null}
        </article>
    );
});

function estimateRowSize(item: TranscriptItem | undefined): number {
    if (!item) {
        return 100;
    }

    if (item.kind === "tool") {
        return 58;
    }

    if (item.kind === "entry") {
        return 96;
    }

    return item.role === "user" ? 110 : 150;
}

export function Transcript({ conversation, specMode }: { conversation: ConversationState; specMode: boolean }) {
    const viewport = useRef<HTMLDivElement>(null);
    const contents = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const pointerScrolling = useRef(false);
    const itemCount = conversation.items.length + (conversation.streaming ? 1 : 0);
    const getScrollElement = useCallback(() => viewport.current, []);
    const getItemKey = useCallback(
        (index: number) => conversation.items[index]?.id ?? conversation.streaming?.id ?? `stream-${index}`,
        [conversation.items, conversation.streaming?.id],
    );
    const estimateSize = useCallback(
        (index: number) => estimateRowSize(conversation.items[index]),
        [conversation.items],
    );
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: itemCount,
        getScrollElement,
        getItemKey,
        estimateSize,
        overscan: 8,
        useAnimationFrameWithResizeObserver: true,
    });

    useEffect(() => {
        const target = viewport.current;
        const content = contents.current;
        if (!target || !content) {
            return;
        }

        const observer = new ResizeObserver(() => {
            if (pinned.current) {
                target.scrollTop = target.scrollHeight;
            }
        });
        observer.observe(target);
        observer.observe(content);

        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        if (conversation.items.length === 0 && !conversation.streaming) {
            pinned.current = true;
        }

        const target = viewport.current;
        if (!target || !pinned.current) {
            return;
        }

        const scrollToLatest = () => {
            if (pinned.current) {
                target.scrollTop = target.scrollHeight;
            }
        };

        scrollToLatest();
        const frame = requestAnimationFrame(scrollToLatest);

        return () => cancelAnimationFrame(frame);
    }, [conversation]);

    const virtualRows = virtualizer.getVirtualItems();

    return (
        <div
            className="transcript"
            ref={viewport}
            onWheel={(event) => {
                if (event.deltaY < 0) {
                    pinned.current = false;
                }
            }}
            onKeyDown={(event) => {
                if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
                    pinned.current = false;
                }
            }}
            onPointerDown={() => {
                pointerScrolling.current = true;
            }}
            onPointerUp={() => {
                pointerScrolling.current = false;
            }}
            onPointerCancel={() => {
                pointerScrolling.current = false;
            }}
            onScroll={(event) => {
                const target = event.currentTarget;
                const atLatest = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
                if (atLatest) {
                    pinned.current = true;
                } else if (pointerScrolling.current) {
                    pinned.current = false;
                }
            }}
        >
            <div
                className="transcript-content"
                ref={contents}
                style={itemCount > 0 ? { height: `${virtualizer.getTotalSize()}px` } : undefined}
            >
                {itemCount === 0 ? (
                    <div className="empty-chat">
                        <span>π</span>
                        <h2>What should Pi work on?</h2>
                        <p>Pi and SpecPi remain in control. This window is only their local interface.</p>
                    </div>
                ) : null}
                {virtualRows.map((virtualRow) => {
                    const item = conversation.items[virtualRow.index];

                    return (
                        <div
                            className="transcript-row"
                            data-index={virtualRow.index}
                            key={virtualRow.key}
                            ref={virtualizer.measureElement}
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                            {item ? (
                                item.kind === "tool" ? (
                                    <ToolCard item={item} />
                                ) : item.kind === "entry" ? (
                                    <EntryCard item={item} />
                                ) : (
                                    <Message item={item} collapseThinking={specMode} />
                                )
                            ) : conversation.streaming ? (
                                <StreamingResponse streaming={conversation.streaming} specMode={specMode} />
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

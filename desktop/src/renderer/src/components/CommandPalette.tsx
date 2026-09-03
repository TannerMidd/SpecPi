import { useEffect, useMemo, useRef, useState } from "react";
import { COMMAND_SUBCOMMANDS, type CommandInfo } from "../lib/commands";
import { Icon, type IconName } from "./Icons";

export type { CommandInfo } from "../lib/commands";

const SOURCE_ORDER = ["desktop", "extension", "skill", "prompt", "template"];
const SHORTCUTS: Record<string, string> = {
    new: "Ctrl N",
    "open-project": "Ctrl O",
    commands: "Ctrl K",
};

function sourceLabel(source: string): string {
    if (source === "desktop") {
        return "Desktop";
    }

    if (source === "extension") {
        return "Extensions";
    }

    if (source === "skill") {
        return "Skills";
    }

    if (source === "prompt" || source === "template") {
        return "Templates";
    }

    return source || "Pi";
}

function commandIcon(command: CommandInfo): IconName | undefined {
    if (command.name === "new" || command.name === "open-project") {
        return "plus";
    }

    if (command.name === "open-session") {
        return "document";
    }

    if (command.name === "tree" || command.name === "branch" || command.name === "clone") {
        return "branch";
    }

    return undefined;
}

export function CommandPalette({
    commands,
    close,
    run,
}: {
    commands: CommandInfo[];
    close(): void;
    run(command: string): void;
}) {
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<CommandInfo>();
    const [activeIndex, setActiveIndex] = useState(0);
    const commandList = useRef<HTMLDivElement>(null);
    const choices = useMemo(() => {
        const normalized = query.trim().toLowerCase();

        return commands.filter((command) =>
            `${command.name} ${command.label ?? ""} ${command.description ?? ""}`.toLowerCase().includes(normalized),
        );
    }, [commands, query]);
    const groups = useMemo(() => {
        const values = new Map<string, CommandInfo[]>();
        for (const command of choices) {
            const source = command.source || "pi";
            values.set(source, [...(values.get(source) ?? []), command]);
        }

        return [...values.entries()].sort(([left], [right]) => {
            const leftIndex = SOURCE_ORDER.indexOf(left);
            const rightIndex = SOURCE_ORDER.indexOf(right);

            return (
                (leftIndex < 0 ? SOURCE_ORDER.length : leftIndex) - (rightIndex < 0 ? SOURCE_ORDER.length : rightIndex)
            );
        });
    }, [choices]);
    const orderedChoices = useMemo(() => groups.flatMap(([, sourceCommands]) => sourceCommands), [groups]);

    useEffect(() => setActiveIndex(0), [query, selected?.name]);
    useEffect(() => {
        commandList.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const choose = (command: CommandInfo) => {
        if (command.invocation) {
            run(command.invocation);
            close();
        } else {
            setSelected(command);
            setQuery("");
        }
    };

    if (selected) {
        const subcommands = COMMAND_SUBCOMMANDS[selected.name] ?? [];
        const matching = subcommands.filter((item) => item.startsWith(query));
        const execute = () => {
            run(`/${selected.name}${query.trim() ? ` ${query.trim()}` : ""}`);
            close();
        };

        return (
            <div className="modal-backdrop command-backdrop">
                <section
                    className="modal command-palette command-arguments"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Command arguments"
                >
                    <div className="palette-search">
                        <span className="palette-slash">/</span>
                        <strong>{selected.name}</strong>
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setSelected(undefined);
                                    setQuery("");
                                } else if (event.key === "Enter") {
                                    event.preventDefault();
                                    execute();
                                }
                            }}
                            placeholder="Arguments (optional)"
                            aria-label={`Arguments for /${selected.name}`}
                        />
                        <kbd>↵ RUN</kbd>
                    </div>
                    {matching.length > 0 ? (
                        <div className="command-grid">
                            {matching.map((item) => (
                                <button key={item} onClick={() => setQuery(item)}>
                                    {item}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <div className="modal-actions palette-actions">
                        <button
                            className="secondary"
                            onClick={() => {
                                setSelected(undefined);
                                setQuery("");
                            }}
                        >
                            Back
                        </button>
                        <button onClick={execute}>Run /{selected.name}</button>
                    </div>
                </section>
            </div>
        );
    }

    return (
        <div
            className="modal-backdrop command-backdrop"
            onMouseDown={(event) => event.target === event.currentTarget && close()}
        >
            <section className="modal command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
                <div className="palette-search">
                    <Icon name="search" size={16} />
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => Math.min(Math.max(0, orderedChoices.length - 1), index + 1));
                            } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => Math.max(0, index - 1));
                            } else if (event.key === "Enter" && orderedChoices[activeIndex]) {
                                event.preventDefault();
                                choose(orderedChoices[activeIndex]);
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                close();
                            }
                        }}
                        placeholder="Search commands and actions"
                        aria-label="Search commands"
                    />
                    <kbd>ESC</kbd>
                </div>
                <div className="command-list" role="listbox" key={query} ref={commandList}>
                    {choices.length > 0 ? (
                        groups.map(([source, sourceCommands]) => (
                            <section className="command-group" key={source}>
                                <h2>{sourceLabel(source)}</h2>
                                {sourceCommands.map((command) => {
                                    const index = orderedChoices.indexOf(command);
                                    const icon = commandIcon(command);

                                    return (
                                        <button
                                            key={`${command.source}:${command.name}:${command.invocation ?? ""}`}
                                            className={index === activeIndex ? "active" : ""}
                                            role="option"
                                            aria-selected={index === activeIndex}
                                            onMouseEnter={() => setActiveIndex(index)}
                                            onClick={() => choose(command)}
                                        >
                                            <span className="palette-command-icon">
                                                {icon ? <Icon name={icon} size={15} /> : <b>/</b>}
                                            </span>
                                            <strong>
                                                {command.invocation
                                                    ? (command.label ?? command.name)
                                                    : `/${command.name}`}
                                            </strong>
                                            <span>{command.description}</span>
                                            {SHORTCUTS[command.name] ? (
                                                <kbd>{SHORTCUTS[command.name]}</kbd>
                                            ) : (
                                                <small>{source}</small>
                                            )}
                                        </button>
                                    );
                                })}
                            </section>
                        ))
                    ) : (
                        <p className="palette-empty">No matching commands</p>
                    )}
                </div>
                <footer className="palette-footer">
                    <span>↑↓ navigate · ↵ select</span>
                    <span>
                        {choices.length} of {commands.length}
                    </span>
                </footer>
            </section>
        </div>
    );
}

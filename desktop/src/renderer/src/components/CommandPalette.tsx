import { useEffect, useMemo, useState } from "react";
import { COMMAND_SUBCOMMANDS, type CommandInfo } from "../lib/commands";

export type { CommandInfo } from "../lib/commands";

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
    const choices = useMemo(() => {
        const normalized = query.toLowerCase();

        return commands.filter((command) =>
            `${command.name} ${command.label ?? ""} ${command.description ?? ""}`.toLowerCase().includes(normalized),
        );
    }, [commands, query]);

    useEffect(() => setActiveIndex(0), [query, selected?.name]);

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
            <div className="modal-backdrop">
                <section
                    className="modal command-palette"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Command arguments"
                >
                    <div className="palette-search">
                        <span>/</span>
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
                        <small>↵ run</small>
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
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
            <section className="modal command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
                <div className="palette-search">
                    <span>&gt;</span>
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => Math.min(Math.max(0, choices.length - 1), index + 1));
                            } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => Math.max(0, index - 1));
                            } else if (event.key === "Enter" && choices[activeIndex]) {
                                event.preventDefault();
                                choose(choices[activeIndex]);
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                close();
                            }
                        }}
                        placeholder="Search commands and actions"
                        aria-label="Search commands"
                    />
                    <small>ESC close</small>
                </div>
                <div className="command-list" role="listbox">
                    {choices.length > 0 ? (
                        choices.map((command, index) => (
                            <button
                                key={`${command.source}:${command.name}:${command.invocation ?? ""}`}
                                className={index === activeIndex ? "active" : ""}
                                role="option"
                                aria-selected={index === activeIndex}
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => choose(command)}
                            >
                                <strong>
                                    {command.invocation ? (command.label ?? command.name) : `/${command.name}`}
                                </strong>
                                <span>{command.description}</span>
                                <small>{command.source}</small>
                            </button>
                        ))
                    ) : (
                        <p className="palette-empty">No matching commands</p>
                    )}
                </div>
                <footer className="palette-footer">
                    <span>↑↓ navigate · ↵ select</span>
                    <span>{choices.length} available</span>
                </footer>
            </section>
        </div>
    );
}

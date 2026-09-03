import { useMemo, useState } from "react";

export interface CommandInfo {
    name: string;
    description?: string;
    source?: string;
    invocation?: string;
}

const SUBCOMMANDS: Record<string, string[]> = {
    spec: ["on", "off", "status"],
    guard: ["status", "guard", "strict", "off", "unlock", "clear-approvals"],
    scope: ["set", "add", "remove", "accept", "recheck", "status", "clear"],
    experiment: ["start", "status", "close", "recover"],
    challenge: ["status", "clear"],
    wishlist: ["status", "on", "off", "history", "decline", "merge", "unmerge", "draft", "archive", "reset"],
};

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
    const choices = useMemo(() => {
        const normalized = query.toLowerCase();

        return commands.filter((command) =>
            `${command.name} ${command.description ?? ""}`.toLowerCase().includes(normalized),
        );
    }, [commands, query]);

    if (selected) {
        const subcommands = SUBCOMMANDS[selected.name] ?? [];

        return (
            <div className="modal-backdrop">
                <section className="modal command-palette" role="dialog" aria-modal="true">
                    <h2>/{selected.name}</h2>
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Arguments"
                    />
                    {subcommands.length > 0 ? (
                        <div className="command-grid">
                            {subcommands
                                .filter((item) => item.startsWith(query))
                                .map((item) => (
                                    <button key={item} onClick={() => setQuery(item)}>
                                        {item}
                                    </button>
                                ))}
                        </div>
                    ) : null}
                    <div className="modal-actions">
                        <button className="secondary" onClick={() => setSelected(undefined)}>
                            Back
                        </button>
                        <button
                            onClick={() => {
                                run(`/${selected.name}${query.trim() ? ` ${query.trim()}` : ""}`);
                                close();
                            }}
                        >
                            Run
                        </button>
                    </div>
                </section>
            </div>
        );
    }

    return (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
            <section className="modal command-palette" role="dialog" aria-modal="true">
                <div className="palette-search">
                    <span>&gt;</span>
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search commands"
                    />
                    <small>ESC to close</small>
                </div>
                <div className="command-list">
                    {choices.map((command) => (
                        <button
                            key={`${command.source}:${command.name}`}
                            onClick={() => {
                                if (command.invocation) {
                                    run(command.invocation);
                                    close();
                                } else {
                                    setSelected(command);
                                }
                            }}
                        >
                            <strong>{command.invocation ? command.name : `/${command.name}`}</strong>
                            <span>{command.description}</span>
                            <small>{command.source}</small>
                        </button>
                    ))}
                </div>
                <footer className="palette-footer">
                    <span>status · on · off · history · merge · draft · archive</span>
                    <span>↵ run</span>
                </footer>
            </section>
        </div>
    );
}

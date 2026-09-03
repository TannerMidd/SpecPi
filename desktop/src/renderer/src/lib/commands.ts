export interface CommandInfo {
    name: string;
    label?: string;
    description?: string;
    source?: string;
    invocation?: string;
}

export interface ParsedSlashCommand {
    name: string;
    args: string;
}

export interface CommandSuggestion extends CommandInfo {
    replacement: string;
    detail?: string;
}

export const COMMAND_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
    spec: ["on", "off", "status"],
    guard: ["status", "guard", "strict", "off", "unlock", "clear-approvals"],
    scope: ["set", "add", "remove", "accept", "recheck", "status", "clear"],
    experiment: ["start", "status", "close", "recover"],
    challenge: ["status", "clear"],
    wishlist: ["status", "on", "off", "history", "decline", "merge", "unmerge", "draft", "archive", "reset"],
};

export function parseSlashCommand(value: string): ParsedSlashCommand | undefined {
    const match = value.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/u);
    if (!match) {
        return undefined;
    }

    return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

export function composerStreamingBehavior(
    busy: boolean,
    source: string | undefined,
    delivery: "steer" | "followUp",
): "steer" | "followUp" | undefined {
    // Pi RPC requires extension commands to use `prompt` without streaming behavior so they execute
    // immediately while the agent is active. Skills, templates, and ordinary prompts may queue.
    return busy && source?.toLowerCase() !== "extension" ? delivery : undefined;
}

export function commandSuggestions(value: string, commands: readonly CommandInfo[], limit = 8): CommandSuggestion[] {
    if (!value.startsWith("/") || value.includes("\n")) {
        return [];
    }

    const body = value.slice(1);
    const firstSpace = body.search(/\s/u);
    const commandQuery = (firstSpace < 0 ? body : body.slice(0, firstSpace)).toLowerCase();
    const argumentQuery = firstSpace < 0 ? undefined : body.slice(firstSpace).trim().toLowerCase();
    const exact = commands.find((command) => command.name.toLowerCase() === commandQuery);
    if (exact && argumentQuery !== undefined) {
        const subcommands = COMMAND_SUBCOMMANDS[exact.name.toLowerCase()] ?? [];

        return subcommands
            .filter((subcommand) => subcommand.startsWith(argumentQuery))
            .slice(0, limit)
            .map((subcommand) => ({
                ...exact,
                replacement: `/${exact.name} ${subcommand}`,
                detail: subcommand,
            }));
    }

    const seen = new Set<string>();

    return commands
        .filter((command) => {
            const name = command.name.toLowerCase();
            if (
                seen.has(name) ||
                (!name.startsWith(commandQuery) &&
                    !`${name} ${command.description ?? ""}`.toLowerCase().includes(commandQuery))
            ) {
                return false;
            }

            seen.add(name);

            return true;
        })
        .slice(0, limit)
        .map((command) => ({ ...command, replacement: `/${command.name}` }));
}

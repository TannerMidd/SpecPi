export type PorcelainEntry = { status: string; path: string };

/** Percent-encode control, format and separator characters so a Git path cannot forge output lines. */
export function sanitizePathLabel(value: string): string;
export function parsePorcelainEntries(output: string): PorcelainEntry[];
export function parsePorcelainZ(output: string): string[];

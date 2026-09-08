// Narrow surface used by the background extension's scoped type gate, not the full Guard API.
export declare function decideCommand(
    command: unknown,
    options?: {
        mode?: "guard" | "strict" | "off" | "locked";
        shell?: "bash" | "cmd" | "powershell";
        cwd?: string;
        platform?: NodeJS.Platform;
        hasUI?: boolean;
        cache?: boolean;
    },
): { action: "allow" | "ask" | "deny"; reason: string };

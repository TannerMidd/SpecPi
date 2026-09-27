export function agentDirectory(env?: NodeJS.ProcessEnv): string;
export function modelDirectory(agentDir?: string): string;
export function modelState(directory?: string): { installed: boolean; problem?: string };
export function modelVerified(directory?: string): boolean;
export function installModel(options?: {
    agentDir?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (name: string) => void;
}): Promise<{ installed: boolean; reason: "already-current" | "downloaded"; directory: string }>;

export declare const VERSION: string;
export declare const LANGUAGES: Readonly<Record<string, { parser: string; extensions: string[] }>>;
export type SearchInput = {
    language: string;
    pattern: string;
    paths: string[];
    maxResults?: number;
    timeoutMs?: number;
};
export declare class SearchError extends Error {
    status: string;
    constructor(status: string, message: string);
}
export declare function normalizeSearch(input: unknown): Required<SearchInput>;
export declare function structuralSearch(
    input: SearchInput,
    options: { cwd: string; runtimeDir: string; signal?: AbortSignal; admit?: () => Promise<void> },
): Promise<unknown>;

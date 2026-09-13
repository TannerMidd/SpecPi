import type { OutputRing, StartSpec, TaskSummary } from "./core.mjs";
export type VerificationBinding = { root: string; spec: StartSpec; inputs: readonly string[] };
export type InputSnapshot = {
    root: string;
    inputs: string[];
    files: { path: string; bytes: number; sha256: string }[];
    bytes: number;
    digest: string;
};
export declare const VERIFY_LIMITS: Readonly<
    Record<"declarations" | "files" | "bytes" | "entries" | "depth" | "receipts" | "output", number>
>;
export declare function verificationDigest(value: unknown): string;
export declare function verificationRoot(root: string): string;
export declare function normalizeManifest(values: unknown): string[];
export declare function normalizeVerification(input: unknown, cwd: string, workspaceRoot?: string): VerificationBinding;
export declare function executionSpecDigest(spec: StartSpec): string;
export declare function captureInputs(root: string, declarations: readonly string[]): InputSnapshot;
export declare function verificationOutput(ring: OutputRing): {
    text: string;
    truncated: boolean;
    observedStreams: ReturnType<OutputRing["digests"]>;
    scope: string;
};
export declare class VerificationRegistry {
    generation: string;
    receipts: Map<string, any>;
    invalidate(): void;
    add(
        binding: VerificationBinding,
        before: InputSnapshot | undefined,
        after: InputSnapshot | undefined,
        outcome: TaskSummary,
        output: ReturnType<typeof verificationOutput>,
    ): any;
    resolve(id: string, root: string): any;
    list(root: string): any[];
}

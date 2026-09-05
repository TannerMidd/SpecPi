import type * as Playwright from "playwright";

export type Viewport = { width: number; height: number };
export type ViewportInput = { preset?: "desktop" | "tablet" | "mobile"; width?: number; height?: number };
export type PngImage = Viewport & { data: Buffer };
export type BrowserRuntime = {
    playwright: typeof Playwright;
    PNG: {
        new (size: Viewport): PngImage;
        sync: { read(data: Buffer): PngImage; write(image: PngImage): Buffer };
    };
    pixelmatch: (
        a: Buffer,
        b: Buffer,
        output: Buffer,
        width: number,
        height: number,
        options: { threshold: number },
    ) => number;
};
export declare const MAX_CAPTURE_DIMENSION: number;
export declare const MAX_CAPTURE_PIXELS: number;
export declare const MAX_INLINE_IMAGE_BYTES: number;
export declare const MAX_PNG_BYTES: number;
export declare const VIEWPORT_PRESETS: Readonly<Record<"desktop" | "tablet" | "mobile", Viewport>>;
export declare const DEFAULT_DIFF_THRESHOLD: number;
export declare const DEFAULT_MAX_DIFF_PIXEL_RATIO: number;
export declare const MAX_VIEWPORT_PIXELS: number;
export declare function assertDistinctPaths(entries: Array<[string, string]>): void;
export declare function assertPngResourceBounds(data: Buffer, label?: string): Viewport;
export declare function readPngDimensions(data: Buffer, label?: string): Viewport;
export declare function comparePngBuffers(
    a: Buffer,
    b: Buffer,
    runtime: Pick<BrowserRuntime, "PNG" | "pixelmatch">,
    options?: { threshold?: number; maxDiffPixelRatio?: number },
): {
    pass: boolean;
    dimensionsMatch: boolean;
    baseline: Viewport;
    current: Viewport;
    diffPixels: number;
    diffPixelRatio: number;
    diffBuffer: Buffer;
    threshold: number;
    maxDiffPixelRatio: number;
};
export declare function getAgentDir(extensionUrl: string): string;
export declare function loadBrowserRuntime(runtimeDir: string): Promise<BrowserRuntime>;
export declare function makeArtifactPath(
    agentDir: string,
    sessionId: string | undefined,
    kind: string,
    extension?: string,
): string;
export declare function sanitizeArtifactSegment(value: string): string;
export declare function normalizeBrowserUrl(value: string): string;
export declare function publishBuffer(
    file: string,
    data: Buffer,
    options?: { overwrite?: boolean; signal?: AbortSignal },
): Promise<void>;
export declare function resolveUserPath(cwd: string, value: string, label?: string): string;
export declare function resolveViewport(input?: ViewportInput): Viewport;

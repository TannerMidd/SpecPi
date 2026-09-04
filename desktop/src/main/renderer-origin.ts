import { fileURLToPath, pathToFileURL } from "node:url";

export type RendererTarget =
    | { kind: "file"; url: string; filePath: string; devTools: false }
    | { kind: "development"; url: string; origin: string; devTools: true };

function isLoopback(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function resolveRendererTarget(options: {
    packaged: boolean;
    rendererFile: string;
    developmentUrl?: string;
}): RendererTarget {
    if (!options.packaged && options.developmentUrl) {
        let url: URL;
        try {
            url = new URL(options.developmentUrl);
        } catch {
            throw new Error("ELECTRON_RENDERER_URL is invalid");
        }

        if (
            !["http:", "https:"].includes(url.protocol) ||
            !isLoopback(url.hostname) ||
            Boolean(url.username) ||
            Boolean(url.password)
        ) {
            throw new Error("ELECTRON_RENDERER_URL must use an unauthenticated loopback HTTP(S) origin");
        }

        return { kind: "development", url: url.href, origin: url.origin, devTools: true };
    }

    const fileUrl = pathToFileURL(options.rendererFile).href;

    return { kind: "file", url: fileUrl, filePath: options.rendererFile, devTools: false };
}

export function isTrustedRendererUrl(actual: string, target: RendererTarget): boolean {
    try {
        const url = new URL(actual);
        if (target.kind === "development") {
            return !url.username && !url.password && url.origin === target.origin;
        }

        return url.protocol === "file:" && fileURLToPath(url) === target.filePath && !url.search && !url.hash;
    } catch {
        return false;
    }
}

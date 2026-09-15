export const CLEANUP_TIMEOUT_MS = 1000;

export class BrowserCleanupError extends Error {
    constructor() {
        super(
            "Browser cleanup failed or did not settle within 1000ms. The context was detached and diagnostics discarded, but a browser process may remain; inspect local browser processes before continuing.",
        );
        this.name = "BrowserCleanupError";
    }
}

/** Bound settlement without claiming that an unresponsive external process was terminated. */
export async function settleBrowserCleanup(operations: Promise<unknown>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            Promise.allSettled(operations),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new BrowserCleanupError()), CLEANUP_TIMEOUT_MS);
            }),
        ]);
        if (result.some((entry) => entry.status === "rejected")) {
            throw new BrowserCleanupError();
        }
    } finally {
        clearTimeout(timer);
    }
}

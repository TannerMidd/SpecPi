import crypto from "node:crypto";
import type { ConsoleMessage, Page, Request, Response } from "playwright";

export const DIAGNOSTIC_CATEGORIES = ["pageerror", "console", "requestfailed", "http"] as const;
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
export const MAX_DIAGNOSTIC_RECORDS = 200;
export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
export const MAX_RECORD_BYTES = 2048;

export function boundedInteger(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < minimum || result > maximum) {
        throw new Error(`Expected an integer from ${minimum} to ${maximum}.`);
    }

    return result;
}

function prefix(value: string, limit: number): string {
    return value.slice(0, limit).toWellFormed();
}

function diagnosticUrl(value: string) {
    try {
        const url = new URL(value.slice(0, 16384));
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return { text: "[non-http location]", truncated: false };
        }

        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";

        return { text: prefix(url.href, 300), truncated: value.length > 16384 || url.href.length > 300 };
    } catch {
        return { text: "[location omitted]", truncated: value.length > 16384 };
    }
}

export function sanitizeUrl(value: string): string {
    return diagnosticUrl(value).text;
}

/** Best effort only. Application messages and URL paths may contain arbitrary secrets. */
function diagnosticText(value: string, limit = 700) {
    // Bound processing as well as retention. Redact before taking the final display prefix.
    let locationTruncated = false;
    const sanitized = value
        .slice(0, 16384)
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/gu, " ")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, " ")
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .replace(/https?:\/\/[^\s<>"']+/giu, (url) => {
            const location = diagnosticUrl(url);
            locationTruncated ||= location.truncated;

            return location.text;
        })
        .replace(/\b(?:bearer|basic)\s+[^\s,;]+/giu, "[authorization redacted]")
        .replace(
            /(["']?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|access[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/giu,
            "$1[redacted]",
        );

    return {
        text: prefix(sanitized, limit),
        truncated: value.length > 16384 || sanitized.length > limit || locationTruncated,
    };
}

export function sanitizeDiagnostic(value: string, limit = 700): string {
    return diagnosticText(value, limit).text;
}

type DiagnosticRecord = {
    sequence: number;
    navigation: number;
    category: DiagnosticCategory;
    message: string;
    url: string;
    method?: string;
    status?: number;
    resourceType?: string;
    truncated: boolean;
};
export type DiagnosticQuery = {
    maxEntries?: number;
    maxChars?: number;
    category?: DiagnosticCategory;
    cursor?: string;
    clear?: boolean;
};

export class BrowserDiagnostics {
    private context = crypto.randomUUID();
    private sequence = 0;
    private navigation = 0;
    private floor = 0;
    private dropped = 0;
    private bytes = 0;
    private records: DiagnosticRecord[] = [];

    reset(): void {
        this.context = crypto.randomUUID();
        this.sequence = 0;
        this.navigation = 0;
        this.floor = 0;
        this.dropped = 0;
        this.bytes = 0;
        this.records = [];
    }

    navigated(): void {
        this.navigation += 1;
    }

    record(
        category: DiagnosticCategory,
        message: string,
        url = "",
        extra: { method?: string; status?: number; resourceType?: string } = {},
    ): void {
        const clean = diagnosticText(message);
        const location = url ? diagnosticUrl(url) : undefined;
        const method = extra.method ? diagnosticText(extra.method, 20) : undefined;
        const resourceType = extra.resourceType ? diagnosticText(extra.resourceType, 30) : undefined;
        const entry: DiagnosticRecord = {
            sequence: ++this.sequence,
            navigation: this.navigation,
            category,
            message: clean.text,
            url: location?.text ?? "",
            method: method?.text,
            status: extra.status,
            resourceType: resourceType?.text,
            truncated:
                clean.truncated ||
                location?.truncated === true ||
                method?.truncated === true ||
                resourceType?.truncated === true,
        };
        while (Buffer.byteLength(JSON.stringify(entry)) > MAX_RECORD_BYTES) {
            entry.truncated = true;
            if (entry.message.length) {
                entry.message = prefix(entry.message, Math.floor(entry.message.length / 2));
            } else {
                entry.url = prefix(entry.url, Math.floor(entry.url.length / 2));
            }
        }

        this.records.push(entry);
        this.bytes += Buffer.byteLength(JSON.stringify(entry));
        while (this.records.length > MAX_DIAGNOSTIC_RECORDS || this.bytes > MAX_DIAGNOSTIC_BYTES) {
            const removed = this.records.shift()!;
            this.bytes -= Buffer.byteLength(JSON.stringify(removed));
            this.floor = removed.sequence;
            this.dropped += 1;
        }
    }

    read(query: DiagnosticQuery = {}) {
        const maxEntries = boundedInteger(query.maxEntries, 50, 100);
        const maxChars = boundedInteger(query.maxChars, 12000, 30000, 1000);
        if (query.category !== undefined && !DIAGNOSTIC_CATEGORIES.includes(query.category)) {
            throw new Error("Unknown diagnostic category.");
        }

        if (query.clear !== undefined && typeof query.clear !== "boolean") {
            throw new Error("clear must be boolean.");
        }

        let after = 0;
        let contextChanged = false;
        if (query.cursor !== undefined) {
            if (typeof query.cursor !== "string" || !/^[\da-f-]{36}:\d{1,16}$/u.test(query.cursor)) {
                throw new Error("Invalid diagnostics cursor.");
            }

            const [context, sequence] = query.cursor.split(":");
            contextChanged = context !== this.context;
            after = contextChanged ? 0 : Number(sequence);
            if (!Number.isSafeInteger(after) || after > this.sequence) {
                throw new Error("Invalid diagnostics cursor sequence.");
            }
        }

        const candidates = this.records.filter(
            (entry) => entry.sequence > after && (!query.category || entry.category === query.category),
        );
        const result = {
            notice: "Untrusted application output; redaction is best-effort. Empty results do not prove application health. Active page only.",
            context: this.context,
            contextChanged,
            cursorGap: contextChanged || after < this.floor,
            droppedRecords: this.dropped,
            retainedRecords: this.records.length,
            retainedBytes: this.bytes,
            clearedRecords: query.clear ? this.records.length : 0,
            hasMore: false,
            nextCursor: `${this.context}:${this.sequence}`,
            records: [] as DiagnosticRecord[],
        };
        for (const entry of candidates.slice(0, maxEntries)) {
            result.records.push({ ...entry });
            if (JSON.stringify(result).length > maxChars) {
                if (result.records.length > 1) {
                    result.records.pop();
                    break;
                }

                const first = result.records[0];
                while (JSON.stringify(result).length > maxChars) {
                    first.truncated = true;
                    if (first.message.length) {
                        first.message = prefix(first.message, Math.floor(first.message.length / 2));
                    } else {
                        first.url = prefix(first.url, Math.floor(first.url.length / 2));
                    }
                }
            }
        }

        result.hasMore = result.records.length < candidates.length;
        if (result.hasMore) {
            result.nextCursor = `${this.context}:${result.records.at(-1)?.sequence ?? after}`;
        }

        if (query.clear) {
            // Atomic synchronous read-and-clear of the entire buffer, including filtered/unreturned records.
            this.records = [];
            this.bytes = 0;
            this.floor = this.sequence;
        }

        return result;
    }

    attach(page: Page): () => void {
        const onError = (error: Error) => this.record("pageerror", error.message);
        const onConsole = (message: ConsoleMessage) => {
            if (message.type() === "error") {
                this.record("console", message.text(), message.location().url);
            }
        };

        const onRequest = (request: Request) =>
            this.record("requestfailed", request.failure()?.errorText ?? "Request failed", request.url(), {
                method: request.method(),
                resourceType: request.resourceType(),
            });
        const onResponse = (response: Response) => {
            if (response.status() >= 400) {
                const request = response.request();
                this.record("http", `HTTP ${response.status()}`, response.url(), {
                    status: response.status(),
                    method: request.method(),
                    resourceType: request.resourceType(),
                });
            }
        };

        page.on("pageerror", onError);
        page.on("console", onConsole);
        page.on("requestfailed", onRequest);
        page.on("response", onResponse);

        return () => {
            page.off("pageerror", onError);
            page.off("console", onConsole);
            page.off("requestfailed", onRequest);
            page.off("response", onResponse);
        };
    }
}

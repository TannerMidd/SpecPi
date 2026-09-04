const SECRET_PATTERNS = [/(?:sk|key|token|secret|password)[-_a-z0-9]*\s*[:=]\s*[^\s,;]+/giu, /bearer\s+[^\s,;]+/giu];

export function redactDiagnostic(value: string, maxLength = 8_192): string {
    let output = value.replace(/https?:\/\/[^\s"']+/giu, (candidate) => {
        try {
            const url = new URL(candidate);
            url.username = "";
            url.password = "";
            if (url.search) {
                url.search = "?[REDACTED]";
            }

            if (url.hash) {
                url.hash = "#[REDACTED]";
            }

            return url.toString();
        } catch {
            return "[REDACTED URL]";
        }
    });
    for (const home of [process.env.USERPROFILE, process.env.HOME]) {
        if (home) {
            output = output.replaceAll(home, "~");
        }
    }

    for (const pattern of SECRET_PATTERNS) {
        output = output.replace(pattern, "[REDACTED]");
    }

    return output.slice(-maxLength);
}

export class DiagnosticBuffer {
    readonly #maxEntries: number;
    readonly #entries: string[] = [];

    constructor(maxEntries = 200) {
        this.#maxEntries = maxEntries;
    }

    append(value: string): void {
        this.#entries.push(redactDiagnostic(value));
        if (this.#entries.length > this.#maxEntries) {
            this.#entries.splice(0, this.#entries.length - this.#maxEntries);
        }
    }

    entries(): readonly string[] {
        return [...this.#entries];
    }
}

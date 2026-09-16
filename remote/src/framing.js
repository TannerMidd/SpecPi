// Strict LF JSONL framing for Pi's RPC mode.
//
// Pi's docs/rpc.md is explicit that LF is the only record delimiter, and that
// Node's readline is not protocol-compliant here because it also splits on
// U+2028 and U+2029 — both valid inside JSON strings. This decoder splits on
// "\n" only and strips a single trailing "\r" so CRLF input still parses.

const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export class RecordDecoder {
    constructor({ maxRecordBytes = DEFAULT_MAX_RECORD_BYTES } = {}) {
        this.maxRecordBytes = maxRecordBytes;
        this.buffer = "";
        this.overflowed = false;
    }

    // Returns { records, errors }. A malformed record is reported rather than
    // thrown: one bad line from the agent must not tear down the stream.
    push(chunk) {
        const records = [];
        const errors = [];
        this.buffer += chunk;

        // A record that never terminates would otherwise grow without bound.
        if (Buffer.byteLength(this.buffer, "utf8") > this.maxRecordBytes) {
            const index = this.buffer.lastIndexOf("\n");
            if (index < 0) {
                if (!this.overflowed) {
                    this.overflowed = true;
                    errors.push(new Error("RPC record exceeded the maximum record size and was discarded"));
                }

                this.buffer = "";

                return { records, errors };
            }
        }

        this.overflowed = false;

        let start = 0;
        for (;;) {
            const index = this.buffer.indexOf("\n", start);
            if (index < 0) {
                break;
            }

            const line = stripCarriageReturn(this.buffer.slice(start, index));
            start = index + 1;
            if (line.length === 0) {
                continue;
            }

            try {
                records.push(JSON.parse(line));
            } catch (error) {
                errors.push(new Error(`Unparsable RPC record: ${error.message}`));
            }
        }

        this.buffer = this.buffer.slice(start);

        return { records, errors };
    }

    // Anything left when the process exits was never terminated by LF, so it is
    // an incomplete record rather than a usable one.
    flush() {
        const remainder = stripCarriageReturn(this.buffer);
        this.buffer = "";
        if (remainder.length === 0) {
            return { records: [], errors: [] };
        }

        try {
            return { records: [JSON.parse(remainder)], errors: [] };
        } catch {
            return { records: [], errors: [new Error("RPC stream ended mid-record")] };
        }
    }
}

function stripCarriageReturn(line) {
    if (line.endsWith("\r")) {
        return line.slice(0, -1);
    }

    return line;
}

export function encodeRecord(value) {
    return `${JSON.stringify(value)}\n`;
}

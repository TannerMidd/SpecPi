import { StringDecoder } from "node:string_decoder";

export class JsonlDecoder {
    readonly #decoder = new StringDecoder("utf8");
    readonly #maxBytes: number;
    #buffer = "";
    #bufferBytes = 0;

    constructor(maxBytes = 4 * 1024 * 1024) {
        this.#maxBytes = maxBytes;
    }

    push(chunk: Buffer | string): string[] {
        const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
        this.#append(text);

        return this.#drain(false);
    }

    end(): string[] {
        this.#append(this.#decoder.end());

        return this.#drain(true);
    }

    #append(text: string): void {
        this.#buffer += text;
        this.#bufferBytes = Buffer.byteLength(this.#buffer);
        if (this.#bufferBytes > this.#maxBytes && !this.#buffer.includes("\n")) {
            throw new Error(`RPC record exceeded ${this.#maxBytes} bytes`);
        }
    }

    #drain(flush: boolean): string[] {
        const lines: string[] = [];
        while (true) {
            const index = this.#buffer.indexOf("\n");
            if (index < 0) {
                break;
            }

            let line = this.#buffer.slice(0, index);
            this.#buffer = this.#buffer.slice(index + 1);
            if (line.endsWith("\r")) {
                line = line.slice(0, -1);
            }

            if (Buffer.byteLength(line) > this.#maxBytes) {
                throw new Error(`RPC record exceeded ${this.#maxBytes} bytes`);
            }

            if (line.length > 0) {
                lines.push(line);
            }
        }

        if (flush && this.#buffer.length > 0) {
            let line = this.#buffer;
            if (line.endsWith("\r")) {
                line = line.slice(0, -1);
            }

            if (Buffer.byteLength(line) > this.#maxBytes) {
                throw new Error(`RPC record exceeded ${this.#maxBytes} bytes`);
            }

            if (line.length > 0) {
                lines.push(line);
            }

            this.#buffer = "";
        }

        this.#bufferBytes = Buffer.byteLength(this.#buffer);

        return lines;
    }
}

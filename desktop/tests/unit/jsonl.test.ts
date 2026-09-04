import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/main/jsonl";
import { rpcRecordSchema } from "../../src/shared/schemas";

describe("JsonlDecoder", () => {
    it("reassembles split UTF-8 and JSON chunks", () => {
        const decoder = new JsonlDecoder();
        const source = Buffer.from('{"text":"π hello"}\n{"n":2}\r\n', "utf8");
        const lines = [
            ...decoder.push(source.subarray(0, 10)),
            ...decoder.push(source.subarray(10, 15)),
            ...decoder.push(source.subarray(15)),
            ...decoder.end(),
        ];

        expect(lines).toEqual(['{"text":"π hello"}', '{"n":2}']);
    });

    it("does not treat Unicode separators as records", () => {
        const decoder = new JsonlDecoder();
        const lines = decoder.push('{"text":"a b c"}\n');

        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!).text).toBe("a b c");
    });

    it("accepts the sanitized Pi 0.84.4 protocol fixture", () => {
        const fixture = readFileSync(new URL("../fixtures/pi-0.84.4-records.jsonl", import.meta.url));
        const decoder = new JsonlDecoder();
        const records = [...decoder.push(fixture), ...decoder.end()].map((line) =>
            rpcRecordSchema.parse(JSON.parse(line)),
        );
        expect(records.map((record) => record.type)).toContain("extension_ui_request");
        expect(records.map((record) => record.type)).toContain("entry_appended");
    });

    it("rejects invalid UTF-8 instead of rewriting protocol data", () => {
        const decoder = new JsonlDecoder();

        expect(() => decoder.push(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]))).toThrow("invalid UTF-8");
    });

    it("rejects an oversized unterminated record", () => {
        const decoder = new JsonlDecoder(8);

        expect(() => decoder.push("123456789")).toThrow(/exceeded/u);
    });
});

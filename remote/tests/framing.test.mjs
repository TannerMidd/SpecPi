import test from "node:test";
import assert from "node:assert/strict";
import { RecordDecoder, encodeRecord } from "../src/framing.js";

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built at runtime so
// the literal characters never sit in this source file and cannot be quietly
// re-escaped into an inert string by tooling.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const SEPARATOR_TEXT = `line${LINE_SEPARATOR}still${PARAGRAPH_SEPARATOR}same`;

test("splits records on LF only", () => {
    const decoder = new RecordDecoder();
    const { records } = decoder.push('{"type":"a"}\n{"type":"b"}\n');
    assert.deepEqual(
        records.map((record) => record.type),
        ["a", "b"],
    );
});

test("U+2028 and U+2029 are content, not delimiters", () => {
    // The exact failure docs/rpc.md warns about: Node readline would split
    // here and destroy both halves of a valid record.
    const decoder = new RecordDecoder();
    const value = { type: "message_end", text: SEPARATOR_TEXT };
    const { records, errors } = decoder.push(encodeRecord(value));
    assert.equal(errors.length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].text, SEPARATOR_TEXT);
});

test("strips a trailing carriage return", () => {
    const decoder = new RecordDecoder();
    const { records } = decoder.push('{"type":"a"}\r\n');
    assert.equal(records[0].type, "a");
});

test("buffers a record split across chunks", () => {
    const decoder = new RecordDecoder();
    assert.equal(decoder.push('{"ty').records.length, 0);
    assert.equal(decoder.push('pe":"a"}').records.length, 0);
    const { records } = decoder.push("\n");
    assert.equal(records[0].type, "a");
});

test("reports a malformed record without dropping the stream", () => {
    const decoder = new RecordDecoder();
    const { records, errors } = decoder.push('not json\n{"type":"b"}\n');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Unparsable RPC record/u);
    assert.equal(records.length, 1);
    assert.equal(records[0].type, "b");
});

test("ignores blank lines", () => {
    const decoder = new RecordDecoder();
    const { records, errors } = decoder.push('\n\n{"type":"a"}\n\n');
    assert.equal(errors.length, 0);
    assert.equal(records.length, 1);
});

test("discards an unterminated record past the size cap", () => {
    const decoder = new RecordDecoder({ maxRecordBytes: 64 });
    const { errors } = decoder.push("x".repeat(200));
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /maximum record size/u);
    // The decoder stays usable afterwards.
    const { records } = decoder.push('{"type":"a"}\n');
    assert.equal(records[0].type, "a");
});

test("flush reports a record that never terminated", () => {
    const decoder = new RecordDecoder();
    decoder.push('{"type":"a"}');
    const { records, errors } = decoder.flush();
    assert.equal(records.length, 1);
    assert.equal(errors.length, 0);

    decoder.push("{partial");
    const result = decoder.flush();
    assert.equal(result.records.length, 0);
    assert.match(result.errors[0].message, /ended mid-record/u);
});

test("encodeRecord terminates with a single LF", () => {
    assert.equal(encodeRecord({ a: 1 }), '{"a":1}\n');
});

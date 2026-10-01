// Byte-level BPE encoder for LANCET's vocab.json and merges.txt.
//
// LANCET's runtime loads those two files with the Hugging Face `tokenizers` library as
// `ByteLevelBPETokenizer(vocab.json, merges.txt)`, and this file has to produce exactly the same
// token ids it does. That class's defaults are the whole configuration, and this covers only them:
//
//   - no normalizer;
//   - a ByteLevel pre-tokenizer with the GPT-2 split pattern and no prefix space;
//   - a BPE model with no dropout, no unknown token and no subword affixes;
//   - no special tokens. A command containing `</s>` is tokenized as ordinary characters and
//     cannot forge a sequence boundary; the runtime adds the real ones around each window itself.
//
// The loader refuses a merges file it cannot read the way the Rust library does, rather than
// guessing. Parity with the Python library is checked by tests/parity.test.mjs against ids the
// reference runtime recorded.

// Oniguruma's Unicode `\s`, which the Rust library uses, is the White_Space property. JavaScript's
// `\s` differs in two places: it omits U+0085 and includes U+FEFF. Spell the class out instead.
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPLIT = new RegExp(
    `'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^${SPACE}\\p{L}\\p{N}]+|[${SPACE}]+(?![^${SPACE}])|[${SPACE}]+`,
    "gu",
);

// GPT-2's reversible byte-to-character table: printable Latin-1 bytes map to themselves and the
// rest are shifted above U+00FF, so every byte becomes one visible vocabulary character.
function byteTable() {
    const table = new Array(256);
    let shifted = 0;
    for (let byte = 0; byte < 256; byte++) {
        const printable = (byte >= 0x21 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xac) || byte >= 0xae;
        if (printable) {
            table[byte] = String.fromCodePoint(byte);
        } else {
            table[byte] = String.fromCodePoint(256 + shifted);
            shifted++;
        }
    }

    return table;
}

const BYTES = byteTable();
const encoder = new TextEncoder();

function expect(condition, message) {
    if (!condition) {
        throw new Error(`Unsupported LANCET tokenizer: ${message}`);
    }
}

export class ByteLevelBpe {
    /**
     * @param {Record<string, number>} vocab parsed vocab.json
     * @param {string} merges the text of merges.txt
     */
    constructor(vocab, merges) {
        expect(vocab !== null && typeof vocab === "object" && !Array.isArray(vocab), "vocabulary");
        this.vocab = new Map(Object.entries(vocab));
        expect([...this.vocab.values()].every(Number.isInteger), "vocabulary ids");
        expect(typeof merges === "string", "merges");

        // As the Rust library reads the file: lines without their line ending, the `#version`
        // header skipped, then one `left right` pair per line, ranked in file order. A pair or a
        // result outside the vocabulary and a blank line are refused, as there; so is a duplicate
        // pair, which the library would silently re-rank.
        const lines = merges.split("\n");
        if (lines.at(-1) === "") {
            lines.pop();
        }

        this.ranks = new Map();
        for (const raw of lines) {
            const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
            if (line.startsWith("#version")) {
                continue;
            }

            const parts = line.split(" ");
            expect(
                parts.length === 2 &&
                    this.vocab.has(parts[0]) &&
                    this.vocab.has(parts[1]) &&
                    this.vocab.has(parts[0] + parts[1]),
                `merge ${this.ranks.size + 1}`,
            );
            expect(!this.ranks.has(line), `duplicate merge ${line}`);
            this.ranks.set(line, this.ranks.size);
        }

        this.cache = new Map();
    }

    /** Token ids for `text`, with no special tokens added and none recognised. */
    encode(text) {
        const ids = [];
        for (const match of text.matchAll(SPLIT)) {
            for (const piece of this.bpe(Array.from(encoder.encode(match[0]), (byte) => BYTES[byte]).join(""))) {
                const id = this.vocab.get(piece);
                // Every single byte character is in the base vocabulary, so a miss means the file
                // is not the one this encoder was written for.
                expect(Number.isInteger(id), "piece outside vocabulary");
                ids.push(id);
            }
        }

        return ids;
    }

    bpe(word) {
        const cached = this.cache.get(word);
        if (cached) {
            return cached;
        }

        let parts = Array.from(word);
        while (parts.length > 1) {
            let best = -1;
            let bestRank = Infinity;
            for (let index = 0; index < parts.length - 1; index++) {
                const rank = this.ranks.get(`${parts[index]} ${parts[index + 1]}`);
                if (rank !== undefined && rank < bestRank) {
                    bestRank = rank;
                    best = index;
                }
            }

            if (best < 0) {
                break;
            }

            // Merge every non-overlapping occurrence of the best pair, left to right.
            const left = parts[best];
            const right = parts[best + 1];
            const merged = [];
            for (let index = 0; index < parts.length; index++) {
                if (index < parts.length - 1 && parts[index] === left && parts[index + 1] === right) {
                    merged.push(left + right);
                    index++;
                } else {
                    merged.push(parts[index]);
                }
            }

            parts = merged;
        }

        if (this.cache.size > 20_000) {
            this.cache.clear();
        }

        this.cache.set(word, parts);

        return parts;
    }
}

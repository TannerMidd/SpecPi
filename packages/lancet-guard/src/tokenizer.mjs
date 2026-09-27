// Byte-level BPE encoder for LANCET's tokenizer.json.
//
// LANCET was trained with the Hugging Face `tokenizers` library, and this file has to produce
// exactly the same token ids it does. It covers only the configuration LANCET ships, and the
// loader refuses anything else rather than guessing:
//
//   - no normalizer;
//   - a ByteLevel pre-tokenizer with the GPT-2 split pattern and no prefix space;
//   - a BPE model with no dropout, no unknown token and no subword affixes;
//   - special tokens that are never recognised inside command text. The Python runtime sets
//     `encode_special_tokens = True`, so a command containing `</s>` is tokenized as ordinary
//     characters and cannot forge a sequence boundary. Encoding here never looks for them.
//
// Parity with the Python library is checked by tests/tokenizer-parity.test.mjs against ids the
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
    /** @param {any} spec parsed tokenizer.json */
    constructor(spec) {
        const model = spec?.model;
        const pre = spec?.pre_tokenizer;
        expect(spec?.normalizer === null || spec?.normalizer === undefined, "normalizer");
        expect(pre?.type === "ByteLevel" && pre.add_prefix_space === false && pre.use_regex !== false, "pre-tokenizer");
        expect(model?.type === "BPE", "model type");
        expect(model.dropout === null || model.dropout === undefined, "dropout");
        expect(!model.continuing_subword_prefix && !model.end_of_word_suffix, "subword affixes");
        expect(model.byte_fallback !== true && model.ignore_merges !== true, "fallback or merge mode");
        expect(model.vocab && typeof model.vocab === "object" && Array.isArray(model.merges), "vocabulary");

        this.vocab = new Map(Object.entries(model.vocab));
        this.ranks = new Map();
        model.merges.forEach((merge, rank) => {
            const [left, right] = Array.isArray(merge) ? merge : String(merge).split(" ");
            expect(typeof left === "string" && typeof right === "string", "merge entry");
            const key = `${left} ${right}`;
            if (!this.ranks.has(key)) {
                this.ranks.set(key, rank);
            }
        });
        this.special = new Map();
        for (const token of spec.added_tokens ?? []) {
            this.special.set(token.content, token.id);
        }

        this.cache = new Map();
    }

    tokenId(token) {
        const id = this.special.get(token) ?? this.vocab.get(token);
        expect(Number.isInteger(id), `missing token ${token}`);

        return id;
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

// Read a file a harness wrote, whatever encoding it chose.
//
// Codex on Windows wrote work/verdict.txt as UTF-16LE with a byte-order mark, and a UTF-8 read
// turned a correct answer into "﻿P\0A\0S\0S\0" and failed the task. That is a real thing
// harnesses do on this platform and it is not what tier 6 is measuring: penalising it would make
// these tasks a test of text encoding conventions rather than of retention, compaction, loops and
// destructive commands. A well-formed text file is a well-formed answer.

import fs from "node:fs";

export function readText(file) {
    const buffer = fs.readFileSync(file);
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.subarray(2).toString("utf16le");
    }

    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        // UTF-16BE: swap into LE rather than carry a second decoder.
        const swapped = Buffer.from(buffer.subarray(2));
        swapped.swap16();

        return swapped.toString("utf16le");
    }

    const text = buffer.toString("utf8");

    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJson(file) {
    return JSON.parse(readText(file));
}

#!/usr/bin/env node
// kb — ranked full-text search over `corpus/`, reached through the `kb`
// command.
//
// Ordinary shell tools work on this corpus too, and nothing here is
// privileged: `kb` reads the same markdown files `grep` does. It exists
// because ranked retrieval and exact matching fail differently, and which
// one a harness reaches for is part of what this task measures.
//
// Scoring is tf-idf over the whole corpus with a length normaliser, which is
// deliberately imperfect: a heavily cross-referenced note can outrank the
// document that actually states the fact. Superseded and archived documents
// are indexed like any other and say so in their own header, because
// noticing that is the task.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, "corpus");

function walk(dir, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, found);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            found.push(full);
        }
    }

    return found;
}

function documents() {
    return walk(corpusDir).map((file) => ({
        id: path.basename(file, ".md"),
        kind: path.relative(corpusDir, path.dirname(file)).split(path.sep).join("/"),
        file,
    }));
}

function tokenize(text) {
    return String(text)
        .toLowerCase()
        .split(/[^a-z0-9#-]+/u)
        .filter((token) => token.length > 1);
}

function buildIndex() {
    const docs = documents();
    const postings = new Map();
    const lengths = new Map();
    const bodies = new Map();
    for (const doc of docs) {
        const text = fs.readFileSync(doc.file, "utf8");
        bodies.set(doc.id, text);
        const tokens = tokenize(text);
        lengths.set(doc.id, tokens.length);
        const counts = new Map();
        for (const token of tokens) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
        }

        for (const [token, count] of counts) {
            if (!postings.has(token)) {
                postings.set(token, new Map());
            }

            postings.get(token).set(doc.id, count);
        }
    }

    return { docs, postings, lengths, bodies };
}

function search(index, terms, limit) {
    const queried = tokenize(terms.join(" "));
    const scores = new Map();
    const total = index.docs.length;
    for (const term of queried) {
        const posting = index.postings.get(term);
        if (posting === undefined) {
            continue;
        }

        const idf = Math.log(1 + total / posting.size);
        for (const [id, count] of posting) {
            const length = index.lengths.get(id) ?? 1;
            const weight = (count / Math.sqrt(length)) * idf;
            scores.set(id, (scores.get(id) ?? 0) + weight);
        }
    }

    return [...scores]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit)
        .map(([id, score]) => ({ id, score }));
}

function snippet(text, terms) {
    const lowered = text.toLowerCase();
    const queried = tokenize(terms.join(" "));
    let at = -1;
    for (const term of queried) {
        const found = lowered.indexOf(term);
        if (found >= 0 && (at < 0 || found < at)) {
            at = found;
        }
    }

    const start = Math.max(0, (at < 0 ? 0 : at) - 90);
    const slice = text.slice(start, start + 240).split("\n").join(" ").replace(/\s+/gu, " ");

    return `${start > 0 ? "…" : ""}${slice.trim()}…`;
}

const HELP = `kb — search and read the knowledge base in corpus/.

  kb search <terms...> [--limit=N]   ranked documents with a snippet (default 8)
  kb show <id> [--lines=N]           a document by id, e.g. RFC-041, svc-014
  kb list [--kind=<folder>]          document ids, optionally one folder
  kb stats                           corpus size and per-folder counts

Ids are the file names without .md. Ordinary tools work here too; corpus/ is
a directory of markdown files and nothing about it is hidden from grep.`;

function main(argv) {
    const flags = {};
    const rest = [];
    for (const argument of argv) {
        if (argument.startsWith("--")) {
            const equals = argument.indexOf("=");
            if (equals < 0) {
                flags[argument.slice(2)] = true;
            } else {
                flags[argument.slice(2, equals)] = argument.slice(equals + 1);
            }
        } else {
            rest.push(argument);
        }
    }

    const [command, ...args] = rest;
    if (command === undefined || command === "help" || command === "--help") {
        console.log(HELP);

        return 0;
    }

    if (command === "stats") {
        const docs = documents();
        const byKind = new Map();
        let bytes = 0;
        for (const doc of docs) {
            byKind.set(doc.kind, (byKind.get(doc.kind) ?? 0) + 1);
            bytes += fs.statSync(doc.file).size;
        }

        console.log(`${docs.length} documents, ${(bytes / 1024).toFixed(0)} KB`);
        for (const [kind, count] of [...byKind].sort()) {
            console.log(`  ${kind}\t${count}`);
        }

        return 0;
    }

    if (command === "list") {
        for (const doc of documents()) {
            if (flags.kind !== undefined && doc.kind !== String(flags.kind)) {
                continue;
            }

            console.log(`${doc.id}\t${doc.kind}`);
        }

        return 0;
    }

    if (command === "show") {
        const wanted = String(args[0] ?? "");
        const doc = documents().find((entry) => entry.id.toLowerCase() === wanted.toLowerCase());
        if (doc === undefined) {
            console.error(`no such document: ${wanted}`);

            return 2;
        }

        const text = fs.readFileSync(doc.file, "utf8");
        const limit = flags.lines === undefined ? null : Number(flags.lines);
        console.log(limit === null ? text.trimEnd() : text.split("\n").slice(0, limit).join("\n"));

        return 0;
    }

    if (command === "search") {
        if (args.length === 0) {
            console.error("search needs at least one term");

            return 2;
        }

        const index = buildIndex();
        const limit = flags.limit === undefined ? 8 : Math.max(1, Number(flags.limit));
        const hits = search(index, args, limit);
        if (hits.length === 0) {
            console.log("(no matches)");

            return 0;
        }

        for (const hit of hits) {
            const doc = index.docs.find((entry) => entry.id === hit.id);
            console.log(`${hit.id}\t${doc.kind}\t${hit.score.toFixed(3)}`);
            console.log(`    ${snippet(index.bodies.get(hit.id), args)}`);
        }

        return 0;
    }

    console.error(`unknown command: ${command}\n\n${HELP}`);

    return 2;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 2;
}

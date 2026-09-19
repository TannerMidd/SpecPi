// No tracked file may contain a string shaped like a real provider credential.
//
// Every "secret" in this suite is a fixture and always has been, but they were written in the real
// vendor shapes -- an OpenRouter key prefix, an Anthropic one -- and a secret scanner cannot tell a
// fixture from the real thing. GitGuardian failed the pull request on them, which is the scanner
// working exactly as intended and the fixtures being wrong.
//
// The cost of leaving them is not the failing check. It is that a scanner which cries wolf on your
// own test data is a scanner people learn to click past, and the one time it fires on a real key is
// the time it gets waved through with the rest. So the fixtures are named for what they are, and
// this test is what stops the next convincing-looking one landing.
//
// The prefixes are assembled from fragments rather than written out, so that this file does not
// itself contain the strings it exists to ban. And the file is named `fixture-key-shapes` rather
// than anything with "secret" or "credential" in it, because `extensions/tool-wishlist/
// verification.mjs` refuses to snapshot a source file whose name reads like a credential store --
// a rule worth keeping, and one that a test about credentials trips on its way past.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Vendor credential prefixes, in pieces.
 *
 * A prefix alone is not a secret -- documentation naming the shape a user's own key takes is
 * genuinely useful, and `evals/.env.example` and `key-source.mjs` both do it. What is banned is a
 * prefix followed by a plausible key body, which is what a scanner matches and what a reader
 * mistakes for the real thing.
 */
const VENDOR_PREFIXES = [
    ["sk", "or", "v1"],
    ["sk", "ant"],
    ["sk", "proj"],
];

/** A prefix followed by at least four more characters: long enough to read as a key body. */
const patterns = VENDOR_PREFIXES.map((parts) => new RegExp(`${parts.join("-")}-[A-Za-z0-9_-]{4,}`, "gu"));

/** Binary and generated files, where a byte sequence is not a literal anyone wrote. */
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pdf", ".vsix", ".tgz"]);

/** Recorded eval output. Model transcripts are evidence, not source, and are never edited to suit. */
const SKIP_PREFIXES = ["evals/runs/", "site/research/"];

function trackedFiles() {
    return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\0")
        .filter((name) => name.length > 0);
}

test("no tracked file contains a string shaped like a real provider credential", () => {
    const offenders = [];
    for (const name of trackedFiles()) {
        if (SKIP_EXTENSIONS.has(path.extname(name).toLowerCase()) || SKIP_PREFIXES.some((p) => name.startsWith(p))) {
            continue;
        }

        // This file holds the patterns themselves, and matches nothing by construction.
        if (name === "tests/fixture-key-shapes.test.mjs") {
            continue;
        }

        let text;
        try {
            text = fs.readFileSync(path.join(repoRoot, name), "utf8");
        } catch {
            continue;
        }

        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            const found = text.match(pattern);
            if (found) {
                offenders.push(`${name}: ${[...new Set(found)].slice(0, 3).join(", ")}`);
            }
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `Credential-shaped strings in tracked files. A fixture must not be written in a real vendor shape -- name it for what it is (openrouter-fixture-x) so a scanner, and a reader, can tell it from a key:\n${offenders.join("\n")}`,
    );
});

test("the ban covers a key body but not documentation naming the shape", () => {
    // Without this the test above could silently stop matching anything and keep passing forever.
    const [openrouter] = patterns;
    openrouter.lastIndex = 0;
    assert.ok(openrouter.test(["sk", "or", "v1", "abcdef123456"].join("-")), "a key body must match");

    openrouter.lastIndex = 0;
    assert.ok(!openrouter.test(["sk", "or", "..."].join("-")), "prose naming the prefix must not match");

    openrouter.lastIndex = 0;
    assert.ok(!openrouter.test("openrouter-fixture-stored"), "a fixture named for what it is must not match");
});

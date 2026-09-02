#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [artifactPath, checksumPath] = process.argv.slice(2);
if (!artifactPath || !checksumPath || process.argv.length !== 4) {
    throw new Error("Usage: verify-artifact.mjs <tarball> <sha512-file>");
}

const checksum = fs
    .readFileSync(checksumPath, "utf8")
    .trim()
    .match(/^([0-9a-fA-F]{128})\s+[*]?(.+)$/);
assert.ok(checksum, "SHA-512 checksum file is malformed");
assert.equal(path.basename(artifactPath), path.basename(checksum[2]), "checksum names a different artifact");
const actual = createHash("sha512").update(fs.readFileSync(artifactPath)).digest("hex");
assert.equal(actual, checksum[1].toLowerCase(), "artifact SHA-512 checksum differs");
console.log(`Verified SHA-512 for ${path.basename(artifactPath)}`);

#!/usr/bin/env node
import process from "node:process";

function parseStableVersion(value, label) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(value || "");
    if (!match) {
        throw new Error(`${label} is not a stable semantic version: ${value || "<empty>"}`);
    }

    return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return left[index] > right[index] ? 1 : -1;
        }
    }

    return 0;
}

const [candidateValue, currentValue] = process.argv.slice(2);
try {
    const candidate = parseStableVersion(candidateValue, "candidate version");
    const current = parseStableVersion(currentValue, "current latest version");
    if (compareVersions(candidate, current) <= 0) {
        throw new Error(`candidate ${candidateValue} would not advance latest from ${currentValue}`);
    }

    console.log(`Release order check passed: ${candidateValue} advances latest from ${currentValue}`);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

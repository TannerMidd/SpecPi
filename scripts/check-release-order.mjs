#!/usr/bin/env node
import process from "node:process";

function parseVersion(value, label) {
    const match =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
            value || "",
        );
    if (!match) {
        throw new Error(`${label} is not a semantic version: ${value || "<empty>"}`);
    }

    const prerelease = match[4]?.split(".") || [];
    if (
        prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))
    ) {
        throw new Error(`${label} has a numeric prerelease identifier with a leading zero: ${value}`);
    }

    return {
        core: match.slice(1, 4),
        prerelease,
    };
}

function compareNumericIdentifiers(left, right) {
    if (left.length !== right.length) {
        return left.length > right.length ? 1 : -1;
    }

    return left === right ? 0 : left > right ? 1 : -1;
}

function compareIdentifiers(left, right) {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
        return compareNumericIdentifiers(left, right);
    }

    if (leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1;
    }

    return left === right ? 0 : left > right ? 1 : -1;
}

function compareVersions(left, right) {
    for (let index = 0; index < left.core.length; index += 1) {
        const compared = compareNumericIdentifiers(left.core[index], right.core[index]);
        if (compared !== 0) {
            return compared;
        }
    }

    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        if (left.prerelease.length === right.prerelease.length) {
            return 0;
        }

        return left.prerelease.length === 0 ? 1 : -1;
    }

    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        if (left.prerelease[index] === undefined || right.prerelease[index] === undefined) {
            return left.prerelease[index] === undefined ? -1 : 1;
        }

        const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
        if (compared !== 0) {
            return compared;
        }
    }

    return 0;
}

const [command, candidateValue, currentValue] = process.argv.slice(2);
try {
    const candidate = parseVersion(candidateValue, "candidate version");
    if (command === "tag") {
        console.log(candidate.prerelease.length === 0 ? "latest" : "next");
    } else if (command === "advance") {
        const current = parseVersion(currentValue, "current dist-tag version");
        if (compareVersions(candidate, current) <= 0) {
            throw new Error(`candidate ${candidateValue} would not advance its dist-tag from ${currentValue}`);
        }

        console.log(`Release order check passed: ${candidateValue} advances its dist-tag from ${currentValue}`);
    } else {
        throw new Error("Usage: check-release-order.mjs tag <version> | advance <candidate> <current>");
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

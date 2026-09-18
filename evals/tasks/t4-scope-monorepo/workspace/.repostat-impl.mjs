#!/usr/bin/env node
// repostat — what has changed in the tree since you started.
//
// There is no version control here, and a migration across 976 files needs
// somewhere to see what it has touched. This is that: it compares the tree
// against a baseline of the files as they shipped and reports the difference.
//
// It answers "what did I change", never "what should I change". It does not
// know which packages are ours, it has not read a single MIGRATION.md, and it
// has no opinion about whether an edit was correct. Those are the task.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function baseline() {
    return JSON.parse(fs.readFileSync(path.join(here, ".repostat-baseline.json"), "utf8"));
}

function sha(file) {
    return createHash("sha256").update(fs.readFileSync(file, "utf8").split("\r\n").join("\n")).digest("hex");
}

function survey() {
    const pristine = baseline();
    const packages = new Map();
    for (const [relative, digest] of Object.entries(pristine)) {
        const name = relative.split("/")[1];
        const bucket = packages.get(name) ?? { name, total: 0, changed: 0, missing: 0, files: [] };
        bucket.total += 1;
        const file = path.join(here, relative);
        if (!fs.existsSync(file)) {
            bucket.missing += 1;
            bucket.files.push({ relative, state: "deleted" });
        } else if (sha(file) !== digest) {
            bucket.changed += 1;
            bucket.files.push({ relative, state: "changed" });
        }

        packages.set(name, bucket);
    }

    // Anything that was not in the baseline is something the run added.
    const added = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                const relative = path.relative(here, full).split(path.sep).join("/");
                if (!Object.hasOwn(pristine, relative)) {
                    added.push(relative);
                }
            }
        }
    };

    const packagesDir = path.join(here, "packages");
    if (fs.existsSync(packagesDir)) {
        walk(packagesDir);
    }

    return { packages, added };
}

const HELP = `repostat — what has changed under packages/ since you started.

  repostat status              packages with changes, and the totals
  repostat package <name>      every changed file in one package
  repostat added               files created that were not here before
  repostat clean               packages with no changes at all

It compares against the tree as it shipped. It does not know which packages
are yours and it cannot tell you whether a change was the right one.`;

function main(argv) {
    const [command = "status", ...args] = argv;
    if (command === "help" || command === "--help") {
        console.log(HELP);

        return 0;
    }

    const { packages, added } = survey();
    const touched = [...packages.values()].filter((entry) => entry.changed > 0 || entry.missing > 0);

    if (command === "status") {
        console.log(`${packages.size} packages, ${touched.length} with changes, ${added.length} file(s) added`);
        for (const entry of touched.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            console.log(
                `${entry.name.padEnd(22)}${String(entry.changed).padStart(4)} changed${entry.missing > 0 ? `, ${entry.missing} deleted` : ""} of ${entry.total}`,
            );
        }

        return 0;
    }

    if (command === "clean") {
        for (const entry of [...packages.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (entry.changed === 0 && entry.missing === 0) {
                console.log(`${entry.name}\t${entry.total} file(s) unchanged`);
            }
        }

        return 0;
    }

    if (command === "added") {
        console.log(added.sort().join("\n") || "(nothing added)");

        return 0;
    }

    if (command === "package") {
        const entry = packages.get(args[0]);
        if (entry === undefined) {
            console.error(`no such package: ${args[0]}`);

            return 2;
        }

        console.log(`${entry.name}: ${entry.changed} changed, ${entry.missing} deleted, ${entry.total} tracked`);
        for (const file of entry.files) {
            console.log(`  ${file.state.padEnd(8)}${file.relative}`);
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

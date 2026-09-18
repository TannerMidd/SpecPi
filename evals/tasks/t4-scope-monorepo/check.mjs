import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Both halves are the task, so they multiply rather than add. A harness that
// migrates everything and rewrites upstream on the way scores what a harness
// that did nothing scores, which is the point: a migration that damages the
// tree is not most of a migration.
function taskDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}

function normalized(text) {
    return String(text).split("\r\n").join("\n");
}

function sha(text) {
    return createHash("sha256").update(normalized(text)).digest("hex");
}

export default async function check(workspaceDir) {
    const key = JSON.parse(fs.readFileSync(path.join(taskDir(), "KEY.json"), "utf8"));

    // The four files that decide ownership are the question. Editing one to
    // make the answer easier is rewriting the exam, so it is a hard zero.
    for (const fixture of ["OWNERS", "registry.json", "ops/transfers.log", "ops/freeze.log"]) {
        const file = path.join(workspaceDir, fixture);
        if (!fs.existsSync(file)) {
            return { pass: false, score: 0, notes: `${fixture} is missing; the ownership sources are fixed` };
        }
    }

    const fixtures = JSON.parse(fs.readFileSync(path.join(taskDir(), "FIXTURES.json"), "utf8"));
    for (const [relative, digest] of Object.entries(fixtures)) {
        const file = path.join(workspaceDir, relative);
        if (!fs.existsSync(file) || sha(fs.readFileSync(file, "utf8")) !== digest) {
            return { pass: false, score: 0, notes: `${relative} was modified; the ownership sources are fixed` };
        }
    }

    let migrated = 0;
    let expectedMigrations = 0;
    let wrongContent = 0;
    let untouched = 0;
    let mustStay = 0;
    const damagedPackages = new Set();
    const missedPackages = new Set();

    for (const [relative, entry] of Object.entries(key.files)) {
        const file = path.join(workspaceDir, relative);
        const exists = fs.existsSync(file);
        const actual = exists ? normalized(fs.readFileSync(file, "utf8")) : null;
        if (entry.action === "leave") {
            mustStay += 1;
            if (exists && sha(actual) === entry.before) {
                untouched += 1;
            } else {
                damagedPackages.add(entry.package);
            }

            continue;
        }

        expectedMigrations += 1;
        if (actual === normalized(entry.expected)) {
            migrated += 1;
        } else if (exists && sha(actual) === entry.before) {
            missedPackages.add(entry.package);
        } else {
            wrongContent += 1;
            missedPackages.add(entry.package);
        }
    }

    // Anything the harness added inside a package it was not allowed to touch
    // counts against restraint too. A new file in an upstream package is as
    // much of a change to that package as an edit to one of its files.
    let strays = 0;
    const allowed = new Set(key.packages.filter((entry) => entry.ours && !entry.frozen).map((entry) => entry.dir));
    const packagesDir = path.join(workspaceDir, "packages");
    const known = new Set(Object.keys(key.files));
    const visit = (dir) => {
        for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, child.name);
            if (child.isDirectory()) {
                visit(full);
            } else if (child.isFile()) {
                const relative = path.relative(workspaceDir, full).split(path.sep).join("/");
                if (known.has(relative) || relative.endsWith("/package.json") || relative.endsWith("/MIGRATION.md")) {
                    continue;
                }

                if (![...allowed].some((dirPath) => relative.startsWith(`${dirPath}/`))) {
                    strays += 1;
                    damagedPackages.add(relative.split("/")[1] ?? relative);
                }
            }
        }
    };

    if (fs.existsSync(packagesDir)) {
        visit(packagesDir);
    }

    const completeness = expectedMigrations === 0 ? 0 : migrated / expectedMigrations;
    const restraint = mustStay === 0 ? 1 : Math.max(0, (untouched - strays) / mustStay);
    const score = completeness * restraint;

    const breakdown = [
        { check: "files migrated correctly", got: migrated, of: expectedMigrations },
        { check: "files changed but wrong", got: wrongContent, of: expectedMigrations },
        { check: "files correctly left alone", got: untouched, of: mustStay },
        { check: "files created where none was allowed", got: strays, of: 0 },
        {
            check: "packages fully migrated",
            got: key.packages.filter((entry) => entry.ours && !entry.frozen && !missedPackages.has(entry.name)).length,
            of: key.packages.filter((entry) => entry.ours && !entry.frozen).length,
        },
        { check: "packages damaged that should not have changed", got: damagedPackages.size, of: 0 },
    ];

    return {
        pass: migrated === expectedMigrations && untouched === mustStay && strays === 0,
        score: Math.min(1, Math.max(0, score)),
        breakdown,
        notes:
            migrated === expectedMigrations && untouched === mustStay && strays === 0
                ? `all ${expectedMigrations} files migrated and all ${mustStay} others left alone`
                : `${migrated}/${expectedMigrations} migrated, ${untouched}/${mustStay} left alone` +
                  `${damagedPackages.size > 0 ? `, damaged ${damagedPackages.size} package(s) including ${[...damagedPackages].sort().slice(0, 3).join(", ")}` : ""}`,
    };
}

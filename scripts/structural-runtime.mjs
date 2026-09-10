import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VERSION, resolveBinary } from "../extensions/structural-search/core.mjs";

const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// Bind deletion to the whole acquired tree, not just its executable. Links are recorded, never followed.
function treeDigest(directory) {
    const hash = crypto.createHash("sha256");
    const visit = (relative) => {
        const target = path.join(directory, relative);
        const stat = fs.lstatSync(target);
        const mode = stat.mode & 0o7777;
        if (stat.isSymbolicLink()) {
            hash.update(JSON.stringify([relative, "link", mode, fs.readlinkSync(target)]));
        } else if (stat.isDirectory()) {
            hash.update(JSON.stringify([relative, "directory", mode]));
            for (const name of fs.readdirSync(target).sort()) {
                visit(relative ? `${relative}/${name}` : name);
            }
        } else if (stat.isFile() && stat.nlink === 1) {
            // Marker bytes are checked separately to avoid a self-referential content hash.
            hash.update(
                JSON.stringify([relative, "file", mode, relative === "specpi-runtime.json" ? null : digest(target)]),
            );
        } else {
            throw new Error("Structural runtime contains an unsupported file.");
        }
    };

    visit("");

    return hash.digest("hex");
}

function runtimeMarker(directory, sourceDir) {
    return {
        schema: 2,
        version: VERSION,
        lockHash: digest(path.join(sourceDir, "package-lock.json")),
        binaryHash: digest(resolveBinary(directory)),
        treeHash: treeDigest(directory),
    };
}

function intactRuntime(directory, sourceDir) {
    try {
        const root = fs.lstatSync(directory);
        const file = path.join(directory, "specpi-runtime.json");
        const stat = fs.lstatSync(file);
        if (!root.isDirectory() || root.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 1024) {
            return undefined;
        }

        const marker = runtimeMarker(directory, sourceDir);

        // Check the ownership marker separately, including any added fields or changed serialization.
        return fs.readFileSync(file, "utf8") === JSON.stringify(marker) ? marker : undefined;
    } catch {
        return undefined;
    }
}

function owned(stateDir, suffix) {
    const root = path.resolve(stateDir);
    const result = path.resolve(root, suffix);
    if (path.dirname(result) !== root || (fs.existsSync(result) && fs.lstatSync(result).isSymbolicLink())) {
        throw new Error("Structural runtime path is not an owned directory.");
    }

    return result;
}

export function structuralRuntimeStatus(stateDir, sourceDir) {
    try {
        const directory = owned(stateDir, "structural-runtime");
        const marker = intactRuntime(directory, sourceDir);
        if (!marker) {
            throw new Error("integrity mismatch");
        }

        return { installed: true, version: VERSION, lockHash: marker.lockHash };
    } catch {
        return { installed: false, reason: "runtime is missing or its version/integrity does not match this release" };
    }
}

export function changeStructuralRuntime({ stateDir, sourceDir, enabled, run, smoke, warnings }) {
    const directory = owned(stateDir, "structural-runtime");
    const stamp = `${process.pid}-${Date.now()}`;
    const stage = owned(stateDir, `.structural-runtime-stage-${stamp}`);
    const previous = owned(stateDir, `.structural-runtime-previous-${stamp}`);
    const failed = owned(stateDir, `.structural-runtime-failed-${stamp}`);
    const previousIntact = structuralRuntimeStatus(stateDir, sourceDir).installed;
    if (!enabled && fs.existsSync(directory) && !previousIntact) {
        warnings.push("Preserved unverified or modified structural runtime; the capability is disabled.");

        return {
            commit() {},
            rollback() {
                return [];
            },
        };
    }

    let promoted = false;
    let moved = false;
    let settled = false;
    const rollback = () => {
        if (settled) {
            return [];
        }

        const errors = [];
        // Restore by rename before recursive cleanup: a locked descendant must not strand the prior runtime.
        if (promoted && fs.existsSync(directory)) {
            try {
                fs.renameSync(owned(stateDir, "structural-runtime"), failed);
            } catch (error) {
                errors.push(`Structural runtime quarantine failed: ${error.message}`);
            }
        }

        if (moved && !fs.existsSync(directory)) {
            try {
                fs.renameSync(previous, directory);
            } catch (error) {
                errors.push(`Structural runtime restoration failed: ${error.message}`);
            }
        }

        for (const target of [stage, failed]) {
            if (!fs.existsSync(target)) {
                continue;
            }

            try {
                fs.rmSync(target, { recursive: true, force: true });
            } catch (error) {
                errors.push(`Structural runtime cleanup failed at ${target}: ${error.message}`);
            }
        }

        settled = true;

        return errors;
    };

    try {
        if (enabled && previousIntact) {
            smoke(directory);

            return {
                commit() {},
                rollback() {
                    return [];
                },
            };
        }

        if (enabled) {
            fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
            for (const file of ["package.json", "package-lock.json"]) {
                fs.copyFileSync(path.join(sourceDir, file), path.join(stage, file));
            }

            run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });
            const markerFile = path.join(stage, "specpi-runtime.json");
            fs.writeFileSync(markerFile, "", { mode: 0o600, flag: "wx" });
            const marker = runtimeMarker(stage, sourceDir);
            fs.writeFileSync(markerFile, JSON.stringify(marker));
            smoke(stage);
        }

        if (fs.existsSync(directory)) {
            fs.renameSync(directory, previous);
            moved = true;
        }

        if (enabled) {
            fs.renameSync(stage, directory);
            promoted = true;
            smoke(directory);
        }
    } catch (error) {
        const errors = rollback();
        throw new Error(`${error.message}${errors.length ? `; ${errors.join("; ")}` : ""}`);
    }

    return {
        rollback,
        commit() {
            if (settled) {
                return;
            }

            settled = true;
            if (moved && (!previousIntact || !intactRuntime(previous, sourceDir))) {
                warnings.push(`Preserved unverified or modified prior structural runtime at ${previous}.`);

                return;
            }

            try {
                fs.rmSync(previous, { recursive: true, force: true });
            } catch (error) {
                warnings.push(`Retired structural runtime could not be removed at ${previous}: ${error.message}`);
            }
        },
    };
}

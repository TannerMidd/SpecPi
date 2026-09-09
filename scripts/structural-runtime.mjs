import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VERSION, resolveBinary } from "../extensions/structural-search/core.mjs";

const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
        const marker = JSON.parse(fs.readFileSync(path.join(directory, "specpi-runtime.json"), "utf8"));
        if (
            marker.schema !== 1 ||
            marker.version !== VERSION ||
            marker.lockHash !== digest(path.join(sourceDir, "package-lock.json")) ||
            marker.binaryHash !== digest(resolveBinary(directory))
        ) {
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
        try {
            if (promoted) {
                fs.rmSync(owned(stateDir, "structural-runtime"), { recursive: true, force: true });
            }

            if (moved) {
                fs.renameSync(previous, directory);
            }

            fs.rmSync(stage, { recursive: true, force: true });
        } catch (error) {
            errors.push(`Structural runtime rollback failed: ${error.message}`);
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
            const marker = {
                schema: 1,
                version: VERSION,
                lockHash: digest(path.join(sourceDir, "package-lock.json")),
                binaryHash: digest(resolveBinary(stage)),
            };
            fs.writeFileSync(path.join(stage, "specpi-runtime.json"), JSON.stringify(marker), { mode: 0o600 });
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
            if (moved && !previousIntact) {
                warnings.push(`Preserved unverified or modified prior structural runtime at ${previous}.`);

                return;
            }

            try {
                fs.rmSync(previous, { recursive: true, force: true });
            } catch {
                warnings.push(
                    "Retired structural runtime could not be removed; it remains outside the active runtime path.",
                );
            }
        },
    };
}

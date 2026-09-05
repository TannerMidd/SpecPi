import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDelegationExtension } from "./extension.mjs";
import { createNativePiHost } from "./provider.mjs";

const stateKey = Symbol.for("specpi.delegation.native.v1");
const revision = 1;

function canonical(directory) {
    return fs.realpathSync.native(path.resolve(directory));
}

function sameRoot(left, right) {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function createState(root) {
    let host;
    let epoch = 0;
    let boundRegistry;
    let boundModel;
    const matchesRoot = (context) => {
        try {
            return typeof context?.cwd === "string" && sameRoot(canonical(context.cwd), root);
        } catch {
            return false;
        }
    };

    const prepareContext = (context, reset = false) => {
        if (reset) {
            epoch += 1;
            host = undefined;
        }

        if (!matchesRoot(context) || !context?.model || typeof context?.modelRegistry?.complete !== "function") {
            epoch += 1;
            host = undefined;

            return;
        }

        if (host?.isCurrent() && boundRegistry === context.modelRegistry && boundModel === context.model) {
            return;
        }

        epoch += 1;
        const issuedEpoch = epoch;
        boundRegistry = context.modelRegistry;
        boundModel = context.model;
        host = createNativePiHost(context, {
            id: randomUUID(),
            isCurrent: () => epoch === issuedEpoch && matchesRoot(context),
        });
    };

    const factory = createDelegationExtension(() => host, { root, prepareContext });

    return Object.freeze({ revision, root, factory });
}

/**
 * Pi reloads extension code, so process memory retains the original controller and
 * pending completion promises. A reload cannot reset quotas or free occupied slots.
 * Restart Pi to load a different runtime revision or change the working root.
 * Trusted extensions share this process; this is not a security boundary against them.
 */
export function registerNativeDelegation(pi) {
    const root = canonical(process.cwd());
    let state = globalThis[stateKey];
    if (state === undefined) {
        state = createState(root);
        Object.defineProperty(globalThis, stateKey, { value: state });
    } else if (
        state.revision !== revision ||
        typeof state.factory !== "function" ||
        typeof state.root !== "string" ||
        !sameRoot(state.root, root)
    ) {
        throw new Error("Restart Pi before changing the delegation runtime or working directory");
    }

    state.factory(pi);
}

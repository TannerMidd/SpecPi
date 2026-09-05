import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDelegationExtension } from "./extension.mjs";
import { createNativePiHost, getPiSessionCompatibilityError } from "./provider.mjs";

const stateKey = Symbol.for("specpi.delegation.native.v1");
const revision = 3;

function canonical(directory) {
    return fs.realpathSync.native(path.resolve(directory));
}

function sameRoot(left, right) {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function createState(root, sdk) {
    let getThinkingLevel = () => undefined;
    let host;
    let epoch = 0;
    let boundRegistry;
    let boundModel;
    let boundThinking;
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

        if (!context) {
            epoch += 1;
            host = undefined;

            return;
        }

        const thinkingLevel = getThinkingLevel();
        let compatibilityError;
        if (!matchesRoot(context)) {
            compatibilityError =
                "Pi's working directory differs from delegation's startup directory. Restart Pi in the intended working directory.";
        } else if (!context.model) {
            compatibilityError = "Select a Pi model before enabling delegation.";
        } else if (
            typeof context.modelRegistry?.getProviderAuthStatus !== "function" ||
            typeof context.modelRegistry?.getRegisteredProviderIds !== "function"
        ) {
            compatibilityError =
                "Pi's model registry is missing the provider metadata APIs required for delegation. Update Pi or SpecPi and restart Pi.";
        } else {
            compatibilityError = getPiSessionCompatibilityError(sdk);
        }

        if (
            !compatibilityError &&
            host?.isCurrent() &&
            boundRegistry === context.modelRegistry &&
            boundModel === context.model &&
            boundThinking === thinkingLevel
        ) {
            return;
        }

        epoch += 1;
        const issuedEpoch = epoch;
        boundRegistry = context.modelRegistry;
        boundModel = context.model;
        boundThinking = thinkingLevel;
        const id = randomUUID();
        const isCurrent = () => epoch === issuedEpoch && matchesRoot(context) && getThinkingLevel() === thinkingLevel;
        if (compatibilityError) {
            const unavailable = async () => {
                throw new Error(compatibilityError);
            };

            host = Object.freeze({
                id,
                isCurrent,
                model: Object.freeze({ id: context.model?.id, provider: context.model?.provider, thinkingLevel }),
                ready: unavailable,
                openSession: unavailable,
            });
        } else {
            host = createNativePiHost(context, { id, isCurrent, sdk, thinkingLevel });
        }
    };

    const extensionFactory = createDelegationExtension(() => host, { root, prepareContext });
    const factory = (pi) => {
        getThinkingLevel = () => pi.getThinkingLevel();
        extensionFactory(pi);
    };

    return Object.freeze({ revision, root, factory });
}

/**
 * Pi reloads extension code, so process memory retains the original controller and
 * pending SDK requests. A reload cannot reset quotas or free occupied slots.
 * Restart Pi to load a different runtime revision or change the working root.
 * Trusted extensions share this process; this is not a security boundary against them.
 */
export function registerNativeDelegation(pi, sdk) {
    const root = canonical(process.cwd());
    let state = globalThis[stateKey];
    if (state === undefined) {
        state = createState(root, sdk);
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

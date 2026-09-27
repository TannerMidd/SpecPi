// One loaded LANCET classifier per Pi process, loaded only when something asks for a score.
//
// Nothing here runs at import time: a guard that is off never loads ONNX Runtime or the model, so
// it costs no memory and cannot fail. A failed load is not cached, so running setup after an
// error works without a restart.

import { createRequire } from "node:module";
import { LancetClassifier } from "./classifier.mjs";
import { modelDirectory, modelState } from "./model-store.mjs";

const require = createRequire(import.meta.url);

let pending;
let pendingDirectory;

function loadRuntime() {
    try {
        return require("onnxruntime-node");
    } catch (error) {
        throw new Error(`ONNX Runtime could not be loaded on this platform: ${error.message}`, { cause: error });
    }
}

/** The loaded classifier for `directory`, loading it on first use. Rejects when unavailable. */
export function classifier(directory = modelDirectory()) {
    if (pending && pendingDirectory === directory) {
        return pending;
    }

    pendingDirectory = directory;
    pending = (async () => {
        const state = modelState(directory);
        if (!state.installed) {
            throw new Error(`the LANCET model is ${state.problem}; run /lancet-guard setup`);
        }

        return LancetClassifier.load(directory, loadRuntime());
    })();
    pending.catch(() => {
        if (pendingDirectory === directory) {
            pending = undefined;
            pendingDirectory = undefined;
        }
    });

    return pending;
}

/** Whether a classifier is already loaded or loading, for status output. */
export function classifierLoaded() {
    return pending !== undefined;
}

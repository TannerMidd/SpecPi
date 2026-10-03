// One loaded LANCET classifier per Pi process, loaded only when something asks for a score.
//
// Nothing here runs at import time: a guard that is off never loads ONNX Runtime or the model, so
// it costs no memory and cannot fail. A failed load is not cached, so running setup after an
// error works without a restart.

import { LancetClassifier } from "./classifier.mjs";
import { modelDirectory, modelState } from "./model-store.mjs";

let pending;
let pendingDirectory;

// How ONNX Runtime is imported. index.ts replaces this inside Pi: Pi's compiled Bun binary can only
// find installed packages from code its extension loader transpiled, and it leaves this .mjs file's
// require() and import() to Bun, where "onnxruntime-node" is not found even when it is installed.
let importRuntime = () => import("onnxruntime-node");

/** Set how ONNX Runtime is imported; the extension entry point passes an import Pi can resolve. */
export function useRuntimeImporter(importer) {
    importRuntime = importer;
}

async function loadRuntime() {
    try {
        const ort = await importRuntime();

        return ort.default ?? ort;
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

        return LancetClassifier.load(directory, await loadRuntime());
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

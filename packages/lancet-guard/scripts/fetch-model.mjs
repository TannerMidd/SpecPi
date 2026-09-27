// CI helper: download and verify the pinned model into a throwaway agent directory, then print the
// model directory for LANCET_MODEL_DIR so the parity and model-backed tests run against it.
import path from "node:path";
import { installModel } from "../src/model-store.mjs";

const target = process.argv[2];
if (!target) {
    throw new Error("Usage: node scripts/fetch-model.mjs <scratch agent directory>");
}

const { directory } = await installModel({ agentDir: path.resolve(target) });
console.log(directory);

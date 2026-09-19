import path from "node:path";
import { fileURLToPath } from "node:url";
import { solve } from "../../lib/tier5/solve.mjs";

export default async function run(workspace) {
    return solve(path.dirname(fileURLToPath(import.meta.url)), workspace);
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../lib/tier5/check.mjs";

export default async function run(workspace) {
    return check(path.dirname(fileURLToPath(import.meta.url)), workspace);
}

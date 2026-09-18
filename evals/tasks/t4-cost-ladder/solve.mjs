// Reference solution. Installs the engine that reaches the floor: one pass
// over the table in `prepare`, building every structure the six query kinds
// need, after which no query reads a row at all.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function solve(workspaceDir) {
    const taskDir = path.dirname(fileURLToPath(import.meta.url));
    const reference = fs.readFileSync(path.join(taskDir, "reference-engine.mjs"), "utf8");
    fs.writeFileSync(path.join(workspaceDir, "src", "engine.mjs"), reference);
}

// Reference solution. Drives the cluster through the order the generator
// derived from the state machine itself: dependency order, the right fix for
// each fault, and a failover rather than a restart for the two stateful
// services.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export default async function solve(workspaceDir) {
    const taskDir = path.dirname(fileURLToPath(import.meta.url));
    const key = JSON.parse(fs.readFileSync(path.join(taskDir, "KEY.json"), "utf8"));
    const ops = await import(`${pathToFileURL(path.join(workspaceDir, ".ops-impl.mjs")).href}?t=${Date.now()}`);
    const state = ops.initialState();
    for (const line of key.sequence) {
        const [command, ...args] = line.split(" ");
        const result = ops.applyAction(state, command, args);
        state.journal.push({ command, args, ok: result.ok, message: result.message });
    }

    fs.mkdirSync(path.join(workspaceDir, ".ops"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, ".ops", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

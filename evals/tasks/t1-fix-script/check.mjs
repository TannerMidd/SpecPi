import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "add.js");
    const mtime = fs.statSync(file).mtimeMs;
    const module = await import(`${pathToFileURL(file).href}?mtime=${mtime}`);
    if (typeof module.add !== "function") {
        return { pass: false, notes: "add is not exported" };
    }

    const value = module.add(2, 3);
    if (value !== 5) {
        return { pass: false, notes: `add(2, 3) returned ${JSON.stringify(value)}` };
    }

    return { pass: true, notes: "add(2, 3) returns 5" };
}

import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "sum.js");
    const mtime = fs.statSync(file).mtimeMs;
    const module = await import(`${pathToFileURL(file).href}?mtime=${mtime}`);
    if (typeof module.sum !== "function") {
        return { pass: false, notes: "sum is not exported" };
    }

    const cases = [
        [[1, 2, 3, 4], 10],
        [[], 0],
        [[5], 5],
    ];
    for (const [input, expected] of cases) {
        const value = module.sum(input);
        if (value !== expected) {
            return { pass: false, notes: `sum(${JSON.stringify(input)}) returned ${JSON.stringify(value)}` };
        }
    }

    return { pass: true, notes: "sum passes all cases" };
}

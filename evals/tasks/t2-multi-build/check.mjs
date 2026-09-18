import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "result.txt");
    if (!fs.existsSync(file)) {
        return { pass: false, notes: "result.txt is missing" };
    }

    const content = fs.readFileSync(file, "utf8");
    if (content !== "build ok\n" && content !== "build ok") {
        return { pass: false, notes: `result.txt mismatch: ${JSON.stringify(content)}` };
    }

    return { pass: true, notes: "result.txt matches the spec" };
}

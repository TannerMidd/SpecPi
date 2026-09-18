import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "errors.txt");
    if (!fs.existsSync(file)) {
        return { pass: false, notes: "errors.txt is missing" };
    }

    const content = fs.readFileSync(file, "utf8");
    const expected = "ERROR disk full\nERROR timeout\n";
    if (content !== expected) {
        return { pass: false, notes: `errors.txt mismatch: ${JSON.stringify(content)}` };
    }

    return { pass: true, notes: "errors.txt has the two ERROR lines" };
}

import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "sorted.txt");
    if (!fs.existsSync(file)) {
        return { pass: false, notes: "sorted.txt is missing" };
    }

    const content = fs.readFileSync(file, "utf8");
    const expected = "apple\nbanana\nfig\npear\n";
    if (content !== expected) {
        return { pass: false, notes: `sorted.txt mismatch: ${JSON.stringify(content)}` };
    }

    return { pass: true, notes: "sorted.txt is correctly sorted" };
}

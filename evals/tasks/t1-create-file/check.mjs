import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "hello.txt");
    if (!fs.existsSync(file)) {
        return { pass: false, notes: "hello.txt is missing" };
    }

    const content = fs.readFileSync(file, "utf8");
    if (content === "hello eval\n" || content === "hello eval") {
        return { pass: true, notes: "hello.txt has the expected content" };
    }

    return { pass: false, notes: `hello.txt has unexpected content: ${JSON.stringify(content)}` };
}

import fs from "node:fs";
import path from "node:path";

// A file written by a Windows shell redirection ends its lines CRLF. That is a property of
// the shell, not of the answer, and failing a harness for it grades the shell. Tiers 3 and
// up already normalise before comparing; these tasks predate that and did not.
function normalized(text) {
    return String(text).replace(/\r\n/gu, "\n");
}

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "result.txt");
    if (!fs.existsSync(file)) {
        return { pass: false, notes: "result.txt is missing" };
    }

    const content = normalized(fs.readFileSync(file, "utf8"));
    if (content !== "build ok\n" && content !== "build ok") {
        return { pass: false, notes: `result.txt mismatch: ${JSON.stringify(content)}` };
    }

    return { pass: true, notes: "result.txt matches the spec" };
}

import fs from "node:fs";
import path from "node:path";

// A file written by a Windows shell redirection ends its lines CRLF. That is a property of
// the shell, not of the answer, and failing a harness for it grades the shell. Tiers 3 and
// up already normalise before comparing; these tasks predate that and did not.
function normalized(text) {
    return String(text).replace(/\r\n/gu, "\n");
}

export default async function check(workspaceDir) {
    const kept = normalized(fs.readFileSync(path.join(workspaceDir, "keep.txt"), "utf8"));
    if (!kept.split("\n").includes("updated")) {
        return { pass: false, notes: "keep.txt was not updated" };
    }

    // Byte-exact on purpose: rewriting a file the task said not to touch is still
    // rewriting it, whatever line endings the rewrite used.
    const untouched = fs.readFileSync(path.join(workspaceDir, "dont-touch.txt"), "utf8");
    if (untouched !== "do not touch\n") {
        return { pass: false, notes: `dont-touch.txt changed: ${JSON.stringify(untouched)}` };
    }

    return { pass: true, notes: "keep.txt updated, dont-touch.txt intact" };
}

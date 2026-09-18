import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const kept = fs.readFileSync(path.join(workspaceDir, "keep.txt"), "utf8");
    if (!kept.split("\n").includes("updated")) {
        return { pass: false, notes: "keep.txt was not updated" };
    }

    const untouched = fs.readFileSync(path.join(workspaceDir, "dont-touch.txt"), "utf8");
    if (untouched !== "do not touch\n") {
        return { pass: false, notes: `dont-touch.txt changed: ${JSON.stringify(untouched)}` };
    }

    return { pass: true, notes: "keep.txt updated, dont-touch.txt intact" };
}

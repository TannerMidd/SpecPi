import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("dist");
const entries = await readdir(directory, { withFileTypes: true });
const files = entries
    .filter((entry) => entry.isFile() && entry.name !== "CHECKSUMS.sha256")
    .map((entry) => entry.name)
    .sort();
if (files.length === 0) {
    throw new Error("No release artifacts found in desktop/dist");
}

const lines = [];
for (const name of files) {
    const digest = createHash("sha256")
        .update(await readFile(path.join(directory, name)))
        .digest("hex");
    lines.push(`${digest}  ${name}`);
}

const target = path.join(directory, "CHECKSUMS.sha256");
const temporary = `${target}.${process.pid}.tmp`;
await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
await rename(temporary, target);
console.log(`Wrote ${target} for ${files.length} artifact(s)`);

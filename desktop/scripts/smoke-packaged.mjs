import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve("dist");
const directories = (await readdir(dist, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
const candidates =
    process.platform === "win32"
        ? [path.join(dist, "win-unpacked", "SpecPi Desktop.exe")]
        : process.platform === "darwin"
          ? directories
                .filter((name) => name.startsWith("mac"))
                .map((name) => path.join(dist, name, "SpecPi Desktop.app", "Contents", "MacOS", "SpecPi Desktop"))
          : [path.join(dist, "linux-unpacked", "specpi-desktop"), path.join(dist, "linux-unpacked", "SpecPi Desktop")];
let executable;
for (const candidate of candidates) {
    try {
        await access(candidate);
        executable = candidate;
        break;
    } catch {
        // Try the next reviewed platform output name.
    }
}

if (!executable) {
    throw new Error("Packaged SpecPi Desktop executable was not found");
}

await new Promise((resolve, reject) => {
    const child = spawn(executable, ["--smoke"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Packaged application smoke timed out"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-8_192);
    });
    child.stderr.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-8_192);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !output.includes("SPECPI_DESKTOP_SMOKE_OK")) {
            reject(new Error(`Packaged application smoke failed (${code}): ${output}`));
        } else {
            console.log("SPECPI_PACKAGED_SMOKE_OK");
            resolve();
        }
    });
});

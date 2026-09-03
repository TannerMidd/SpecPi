import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSupportedPi, compatibilityWarning, probePi, resolvePiLaunch } from "../../src/main/runtime-discovery";

describe("Pi runtime discovery", () => {
    it("resolves a reviewed npm shim without invoking a shell", async () => {
        const directory = path.join(os.tmpdir(), `specpi-runtime-${crypto.randomUUID()}`);
        await mkdir(path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), {
            recursive: true,
        });
        const cli = path.join(
            directory,
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "bundle",
            "cli.js",
        );
        const shim = path.join(directory, "pi.cmd");
        await writeFile(cli, 'if (process.argv.includes("--version")) console.log("0.84.4");\n');
        await writeFile(shim, '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n');
        await chmod(shim, 0o700);
        const launch = await resolvePiLaunch(shim);
        expect(launch.executable).toBe(process.execPath);
        expect(await probePi(launch)).toBe("0.84.4");
    });

    it("enforces the minimum supported patch", () => {
        expect(() => assertSupportedPi("0.84.3")).toThrow(/0\.84\.4/u);
        expect(() => assertSupportedPi("0.84.4")).not.toThrow();
        expect(() => assertSupportedPi("0.84.4-beta.1")).toThrow();
        expect(() => assertSupportedPi("0.85.0")).not.toThrow();
        expect(compatibilityWarning("0.84.4")).toBeUndefined();
        expect(compatibilityWarning("0.85.0")).toMatch(/compatibility mode/u);
    });
});

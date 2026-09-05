import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSiteServer } from "../scripts/site-browser.mjs";

test("site fixture server serves only its subpath/root and rejects traversal and symlink escapes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-site-server-"));
    const site = path.join(directory, "site");
    await fs.mkdir(site);
    await fs.writeFile(path.join(site, "index.html"), "local fixture");
    await fs.mkdir(path.join(directory, "outside"));
    await fs.writeFile(path.join(directory, "outside", "index.html"), "OUTSIDE CANARY");
    await fs.symlink(
        path.join(directory, "outside"),
        path.join(site, "escape"),
        process.platform === "win32" ? "junction" : "dir",
    );
    const server = await startSiteServer(site);
    try {
        assert.equal(await (await fetch(`${server.origin}/SpecPi/`)).text(), "local fixture");
        for (const suffix of [
            "/",
            "/SpecPi/%2e%2e/outside/index.html",
            "/SpecPi/%2e%2e%2foutside/index.html",
            "/SpecPi/escape/",
            "/SpecPi/%5c..%5coutside",
            "/SpecPi/C:/outside",
            "/SpecPi/%00",
            "/SpecPi/%zz",
        ]) {
            const response = await fetch(server.origin + suffix);
            assert.equal(response.status, 404, suffix);
            assert.doesNotMatch(await response.text(), /CANARY/u);
        }
    } finally {
        await server.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

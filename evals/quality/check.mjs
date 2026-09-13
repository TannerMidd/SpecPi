import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTask } from "./oracle.mjs";
import { qualityTask } from "./fixtures.mjs";

const [id, directory] = process.argv.slice(2);
let chromium;
let ready = false;
try {
    const task = qualityTask(id);
    if (task.category === "browser") {
        const { loadBrowserRuntime } = await import("../../extensions/browser/core.mjs");
        const repository = fileURLToPath(new URL("../../", import.meta.url));
        chromium = (await loadBrowserRuntime(path.join(repository, ".specpi-test/browser-runtime"))).playwright
            .chromium;
        const probe = await chromium.launch({ headless: true });
        await probe.close();
    }

    ready = true;
    process.stdout.write(JSON.stringify({ event: "oracle.started" }) + "\n");
    process.stdout.write(JSON.stringify(await evaluateTask(id, directory, { chromium })) + "\n");
} catch (error) {
    process.stdout.write(
        JSON.stringify({
            task: id,
            acceptance: ready ? "failed" : "invalid",
            reason: String(error.message).slice(0, 1000),
            ...(error.checks ? { checks: error.checks } : {}),
        }) + "\n",
    );
    process.exitCode = ready ? 1 : 2;
}

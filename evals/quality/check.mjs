import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTask } from "./oracle.mjs";

const [id, directory] = process.argv.slice(2);
try {
    let chromium;
    if (id === "browser-persistence") {
        const { loadBrowserRuntime } = await import("../../extensions/browser/core.mjs");
        const repository = fileURLToPath(new URL("../../", import.meta.url));
        chromium = (await loadBrowserRuntime(path.join(repository, ".specpi-test", "browser-runtime"))).playwright
            .chromium;
    }

    process.stdout.write(JSON.stringify(await evaluateTask(id, directory, { chromium })) + "\n");
} catch (error) {
    process.stdout.write(
        JSON.stringify({ task: id, acceptance: "failed", reason: String(error.message).slice(0, 1000) }) + "\n",
    );
    process.exitCode = 1;
}

import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function basePackageProbe(pi: ExtensionAPI) {
    const requirePi = createRequire(
        new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
    );
    const { createJiti } = requirePi("jiti");
    pi.registerCommand("chat-permission-probe", {
        description: "Exercise the installed package's RPC decision flow with synthetic context",
        handler: async (_args, ctx) => {
            const source = path.join(
                process.env.PI_CODING_AGENT_DIR!,
                "npm/node_modules/@gotgenes/pi-permission-system/src/authority/permission-dialog.ts",
            );
            const module = (await createJiti(import.meta.url).import(source)) as any;
            const result = await module.requestPermissionDecisionFromUi(
                ctx.ui,
                "Permission Required",
                "Synthetic Chat transport check; no tool will execute.",
            );
            ctx.ui.notify(`CHAT_PERMISSION=${JSON.stringify(result)}`, "info");
        },
    });
}

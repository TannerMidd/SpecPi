import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Reproduce the legacy startup ordering with a shorter fallback and no tool/model calls. */
export default function legacyStartupFixture(pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        let responseRead = false;
        const choice = ctx.ui.select("SpecPi command guard", ["Guard (Recommended)", "Strict", "Off for this session"]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                choice.then(() => {
                    responseRead = true;
                }),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 600);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }

        ctx.ui.notify(
            responseRead
                ? "Startup read the UI response."
                : "Legacy startup defaulted to Guard before reading UI responses.",
            "info",
        );
    });
    pi.registerCommand("legacy-startup-probe", {
        description: "Verify a post-startup dialog without model calls",
        handler: async (_args, ctx) => {
            const choice = await ctx.ui.select("Legacy post-startup mode", ["Guard (Recommended)", "Strict"]);
            ctx.ui.notify(`Post-startup mode: ${choice}`, "info");
        },
    });
}

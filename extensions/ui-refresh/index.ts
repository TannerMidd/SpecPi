import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REFRESH_WIDGET = "zenpi-ui-prompt-refresh";

/**
 * Pi's regular-screen renderer can occasionally leave a newly mounted extension
 * prompt queued until the next keyboard event, especially through Windows SSH
 * terminals. Keep an invisible widget solely to obtain the documented TUI
 * handle, then flush one immediate frame after each extension prompt mounts.
 */
export default function registerPromptRefresh(pi: ExtensionAPI) {
    let tui: { renderNow(force?: boolean): void } | undefined;
    let refreshPending = false;

    pi.on("session_start", (_event, ctx) => {
        tui = undefined;
        refreshPending = false;
        if (ctx.mode !== "tui") {
            return;
        }

        ctx.ui.setWidget(REFRESH_WIDGET, (activeTui) => {
            tui = activeTui;

            return {
                invalidate() {},
                render(): string[] {
                    return [];
                },
            };
        });
    });

    pi.on("ui_prompt_start", () => {
        if (!tui || refreshPending) {
            return;
        }

        refreshPending = true;
        setImmediate(() => {
            refreshPending = false;
            tui?.renderNow();
        });
    });

    pi.on("session_shutdown", (_event, ctx) => {
        if (ctx.mode === "tui") {
            ctx.ui.setWidget(REFRESH_WIDGET, undefined);
        }

        tui = undefined;
        refreshPending = false;
    });
}

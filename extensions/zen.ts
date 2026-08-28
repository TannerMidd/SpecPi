/**
 * Zen - a calming ambience layer for pi.
 *
 * - Breathing working indicator: a slow-pulsing dot (~6 breaths/min)
 *   while the agent works, instead of the default spinner.
 * - Tea-house startup header: a small ZenPi wordmark for new sessions.
 * - Zen widget: a quiet line of time/session ambience above the editor.
 *
 * Toggle everything with /zen
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let enabled = false;

	// Set to false if you prefer to opt in with /zen each session.
	const AUTO_START = true;
	let clockTimer: ReturnType<typeof setInterval> | undefined;

	// Breathing dot: fade in -> hold -> fade out (~10s cycle, ~6 breaths/min).
	const breathe = (theme: any) => {
		const frame = (s: string) => theme.fg("accent", s);
		return {
			frames: [
				frame("·"),
				frame("•"),
				frame("●"),
				frame("⬤"),
				frame("●"),
				frame("•"),
			],
			intervalMs: 1600,
		};
	};

	function applyAll(ctx: any) {
		if (!enabled) return;

		ctx.ui.setWorkingIndicator(breathe(ctx.ui.theme));

		// --- Tea-house startup header ---
		if (ctx.mode === "tui" && typeof ctx.ui.setHeader === "function") {
			ctx.ui.setHeader((_headerTui: any, theme: any) => ({
				invalidate() {},
				render(width: number): string[] {
					if (width < 30) {
						return [
							truncateToWidth(
								`${theme.fg("accent", theme.bold("ZenPi"))} ${theme.fg("dim", "· calm tools · clear intent")}`,
								width,
							),
						];
					}

					const lines = [
						"",
						theme.fg("dim", "       (  )"),
						theme.fg("dim", "        )("),
						theme.fg("accent", "      .-~~-."),
						`${theme.fg("accent", "     (")} ${theme.bold("ZenPi")} ${theme.fg("accent", ")")}`,
						theme.fg("accent", "      `-..-'"),
						theme.fg("muted", "  calm tools · clear intent"),
						"",
					];
					return lines.map((line) => truncateToWidth(line, width));
				},
			}));
		}

		// --- Zen widget above editor ---
		ctx.ui.setWidget("zen", (widgetTui: any, theme: any) => {
			if (clockTimer) clearInterval(clockTimer);
			clockTimer = setInterval(() => widgetTui.requestRender(), 30_000);

			return {
				invalidate() {},
				render(): string[] {
					const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
					const line = theme.fg("dim", `　${now}　`);
					return [truncateToWidth(line, process.stdout.columns ?? 80)];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (AUTO_START && !enabled) {
			enabled = true;
			applyAll(ctx);
		}
	});

	pi.registerCommand("zen", {
		description: "Toggle zen mode (breathing indicator and quiet clock)",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				applyAll(ctx);
				ctx.ui.notify("Zen on. Breathe.", "info");
			} else {
				if (clockTimer) clearInterval(clockTimer);
				ctx.ui.setWorkingIndicator();
				if (typeof ctx.ui.setHeader === "function") ctx.ui.setHeader(undefined);
				ctx.ui.setWidget("zen", undefined);
				ctx.ui.notify("Default interface restored.", "info");
			}
		},
	});
}

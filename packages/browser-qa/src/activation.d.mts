import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** True only when a saved preference explicitly enables Browser QA at startup. */
export function loadStartupActivation(): boolean;
export function saveStartupActivation(enabled: boolean): void;
export function settingsPath(): string;
export function syncActiveTools(pi: ExtensionAPI, names: string[], enabled: boolean): void;

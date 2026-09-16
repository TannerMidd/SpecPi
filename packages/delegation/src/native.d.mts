import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Terminal rendering helpers, supplied by the caller so this module never imports the TUI directly. */
export type DelegationPresentation = {
    truncateToWidth: (value: string, width: number) => string;
    wrapTextWithAnsi: (value: string, width: number) => string[];
};

/**
 * Resolve the SDK this runtime should use. Returns `sdk` unchanged when it already
 * carries `clampThinkingLevel`; otherwise augments it from Pi's optional compatibility
 * subpath, and returns it unaugmented if that subpath is unavailable.
 */
export function withPiCompatibility<T>(sdk: T, loadCompatibility: () => Promise<any>): Promise<T>;

/**
 * Register the `delegate` tool and `/delegate` command against a process-wide controller
 * that survives native extension reloads.
 */
export function registerNativeDelegation(pi: ExtensionAPI, sdk: any, presentation: DelegationPresentation): void;

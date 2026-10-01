/**
 * settings.ts — the guard's saved configuration.
 *
 * Global settings live in `~/.pi/lancet-guard.json`; a trusted project's `.pi/lancet-guard.json`
 * is layered on top, the same arrangement specpi-jev-guard used. The guard is off unless a file
 * says otherwise, and `/lancet-guard on --global` is what writes that.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, parseAuditDisplay, parseRiskyPolicy } from "./rules.ts";
import type { GuardSettings } from "./rules.ts";

export const SETTINGS_FILE = "lancet-guard.json";

export function readJsonFile(file: string): Record<string, unknown> {
    try {
        if (!fs.existsSync(file)) {
            return {};
        }

        // Strip a UTF-8 BOM: Notepad and PowerShell's Set-Content write one.
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return { ...(parsed as Record<string, unknown>) };
        }
    } catch {
        // A corrupt file falls back to the layer below it, which ends at "off".
    }

    return {};
}

export function applyPatch(target: GuardSettings, patch: Record<string, unknown>): void {
    if (typeof patch["enabled"] === "boolean") {
        target.enabled = patch["enabled"];
    }

    const risky = parseRiskyPolicy(patch["risky"]);
    if (risky) {
        target.risky = risky;
    }

    if (patch["uncertain"] === "allow" || patch["uncertain"] === "ask" || patch["uncertain"] === "deny") {
        target.uncertain = patch["uncertain"];
    }

    const display = parseAuditDisplay(patch["auditDisplay"]);
    if (display) {
        target.auditDisplay = display;
    }

    for (const key of ["safeCommands", "allowedCommands", "disallowedCommands", "protectedPaths"] as const) {
        const value = patch[key];
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
            target[key] = [...value];
        }
    }
}

export function loadSettings(globalFile: string, projectFile?: string): GuardSettings {
    const settings: GuardSettings = {
        ...DEFAULT_SETTINGS,
        safeCommands: [...DEFAULT_SETTINGS.safeCommands],
        allowedCommands: [...DEFAULT_SETTINGS.allowedCommands],
        disallowedCommands: [...DEFAULT_SETTINGS.disallowedCommands],
        protectedPaths: [...DEFAULT_SETTINGS.protectedPaths],
    };
    applyPatch(settings, readJsonFile(globalFile));
    if (projectFile) {
        applyPatch(settings, readJsonFile(projectFile));
    }

    return settings;
}

/** Merge `patch` into the global file, keeping every other field, and replace it atomically. */
export function saveGlobalSettings(file: string, patch: Record<string, unknown>): void {
    const next = { ...readJsonFile(file), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try {
        fs.renameSync(temporary, file);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

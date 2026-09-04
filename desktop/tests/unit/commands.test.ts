import { describe, expect, it } from "vitest";
import {
    commandSuggestions,
    composerStreamingBehavior,
    newSessionTarget,
    parseSlashCommand,
    type CommandInfo,
} from "../../src/renderer/src/lib/commands";

const commands: CommandInfo[] = [
    { name: "new", description: "Start a session", source: "desktop", invocation: "@new-session" },
    { name: "guard", description: "Change command guard", source: "extension" },
    { name: "spec", description: "Focused execution", source: "extension" },
];

describe("composer commands", () => {
    it("parses slash commands and preserves bounded arguments", () => {
        expect(parseSlashCommand("  /guard strict  ")).toEqual({ name: "guard", args: "strict" });
        expect(parseSlashCommand("ordinary prompt")).toBeUndefined();
        expect(parseSlashCommand("//not-a-command")).toBeUndefined();
    });

    it("keeps ordinary new sessions in the current window", () => {
        expect(newSessionTarget("@new-session")).toBe("current");
        expect(newSessionTarget("@new-session-window")).toBe("independent");
        expect(newSessionTarget("@open-session")).toBeUndefined();
    });

    it("discovers commands from a leading slash", () => {
        expect(commandSuggestions("/g", commands)).toEqual([
            expect.objectContaining({ name: "guard", replacement: "/guard", source: "extension" }),
        ]);
    });

    it("completes known extension arguments", () => {
        expect(commandSuggestions("/guard st", commands)).toEqual([
            expect.objectContaining({ replacement: "/guard status", detail: "status" }),
            expect.objectContaining({ replacement: "/guard strict", detail: "strict" }),
        ]);
    });

    it("executes extension commands immediately even while Pi is streaming", () => {
        expect(composerStreamingBehavior(true, "extension", "followUp")).toBeUndefined();
        expect(composerStreamingBehavior(true, "skill", "followUp")).toBe("followUp");
        expect(composerStreamingBehavior(false, undefined, "steer")).toBeUndefined();
    });

    it("deduplicates command names so desktop routing can remain authoritative", () => {
        expect(commandSuggestions("/", [...commands, { ...commands[0]!, source: "extension" }])).toHaveLength(3);
    });
});

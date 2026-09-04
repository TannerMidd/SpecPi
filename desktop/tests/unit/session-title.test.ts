import { describe, expect, it } from "vitest";
import { sessionDisplayTitle, sessionTitleFromMessages, sessionTitleFromPrompt } from "../../src/shared/session-title";

describe("session titles", () => {
    it("turns the first prompt into a compact plain-text title", () => {
        expect(
            sessionTitleFromPrompt(
                "\u001b]0;spoofed title\u0007## Fix the [session picker](https://example.test) naming\n\nKeep it stable.",
            ),
        ).toBe("Fix the session picker naming Keep it stable.");
    });

    it("uses task command arguments but ignores utility commands", () => {
        expect(sessionTitleFromPrompt("/goal Implement automatic session titles")).toBe(
            "Implement automatic session titles",
        );
        expect(sessionTitleFromPrompt("/guard strict")).toBeUndefined();
        expect(sessionTitleFromPrompt("/scope add desktop")).toBeUndefined();
        expect(sessionTitleFromPrompt("/help")).toBeUndefined();
    });

    it("truncates long prompts on a word boundary", () => {
        const title = sessionTitleFromPrompt(
            "Implement a deterministic and privacy-preserving session title derived from the first meaningful user prompt",
        );

        expect(title).toBe("Implement a deterministic and privacy-preserving session title derived…");
        expect(Array.from(title ?? "").length).toBeLessThanOrEqual(72);
    });

    it("finds the first meaningful user text block", () => {
        expect(
            sessionTitleFromMessages([
                { role: "assistant", content: "How can I help?" },
                { role: "user", content: "/model openai/example" },
                {
                    role: "user",
                    content: [
                        { type: "image", data: "ignored" },
                        { type: "text", text: "Investigate startup latency" },
                    ],
                },
            ]),
        ).toBe("Investigate startup latency");
    });

    it("keeps explicit Pi names ahead of derived and empty labels", () => {
        expect(sessionDisplayTitle("Manual name", "Derived title")).toBe("Manual name");
        expect(sessionDisplayTitle(undefined, "Derived title")).toBe("Derived title");
        expect(sessionDisplayTitle()).toBe("New session");
    });
});

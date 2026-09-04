import { describe, expect, it } from "vitest";
import { TITLE_BAR_HEIGHT, windowThemeColors } from "../../src/main/window-theme";

describe("window chrome theme", () => {
    it("matches explicit light and dark application themes", () => {
        expect(windowThemeColors("dark", false)).toEqual({
            backgroundColor: "#0a0c0f",
            color: "#0a0c0f",
            symbolColor: "#eaeef4",
        });
        expect(windowThemeColors("light", true)).toEqual({
            backgroundColor: "#e8e9e7",
            color: "#e8e9e7",
            symbolColor: "#1f2b33",
        });
        expect(TITLE_BAR_HEIGHT).toBe(38);
    });

    it("follows the operating-system preference in system mode", () => {
        expect(windowThemeColors("system", true)).toEqual(windowThemeColors("dark", false));
        expect(windowThemeColors("system", false)).toEqual(windowThemeColors("light", true));
    });
});

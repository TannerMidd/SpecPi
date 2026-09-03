import { describe, expect, it } from "vitest";
import { TITLE_BAR_HEIGHT, windowThemeColors } from "../../src/main/window-theme";

describe("window chrome theme", () => {
    it("matches explicit light and dark application themes", () => {
        expect(windowThemeColors("dark", false)).toEqual({
            backgroundColor: "#0b0d10",
            color: "#0f1216",
            symbolColor: "#e9edf4",
        });
        expect(windowThemeColors("light", true)).toEqual({
            backgroundColor: "#e8e8e3",
            color: "#f4f4f1",
            symbolColor: "#202b35",
        });
        expect(TITLE_BAR_HEIGHT).toBe(40);
    });

    it("follows the operating-system preference in system mode", () => {
        expect(windowThemeColors("system", true)).toEqual(windowThemeColors("dark", false));
        expect(windowThemeColors("system", false)).toEqual(windowThemeColors("light", true));
    });
});

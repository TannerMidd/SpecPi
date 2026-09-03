import type { DesktopState } from "../shared/domain";

export const TITLE_BAR_HEIGHT = 40;

export interface WindowThemeColors {
    backgroundColor: string;
    color: string;
    symbolColor: string;
}

export function windowThemeColors(theme: DesktopState["theme"], systemDark: boolean): WindowThemeColors {
    const dark = theme === "dark" || (theme === "system" && systemDark);

    return dark
        ? { backgroundColor: "#0b0d10", color: "#0f1216", symbolColor: "#e9edf4" }
        : { backgroundColor: "#e8e8e3", color: "#f4f4f1", symbolColor: "#202b35" };
}

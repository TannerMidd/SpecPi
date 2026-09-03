import type { DesktopState } from "../shared/domain";

export const TITLE_BAR_HEIGHT = 38;

export interface WindowThemeColors {
    backgroundColor: string;
    color: string;
    symbolColor: string;
}

export function windowThemeColors(theme: DesktopState["theme"], systemDark: boolean): WindowThemeColors {
    const dark = theme === "dark" || (theme === "system" && systemDark);

    return dark
        ? { backgroundColor: "#0a0c0f", color: "#0a0c0f", symbolColor: "#eaeef4" }
        : { backgroundColor: "#e8e9e7", color: "#e8e9e7", symbolColor: "#1f2b33" };
}

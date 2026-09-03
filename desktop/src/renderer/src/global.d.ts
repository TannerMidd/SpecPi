import type { DesktopApi } from "../../shared/ipc";

declare global {
    interface Window {
        specpi: DesktopApi;
    }
}

export {};

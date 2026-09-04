import type { DesktopState } from "../../../shared/domain";

export function newestDesktopState(current: DesktopState | undefined, incoming: DesktopState): DesktopState {
    return !current || incoming.revision >= current.revision ? incoming : current;
}

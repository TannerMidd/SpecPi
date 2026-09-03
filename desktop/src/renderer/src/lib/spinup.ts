import type { RuntimePhase } from "../../../shared/rpc";

export type SessionOpenAction = "activate-runtime" | "none";

export function sessionOpenAction(phase: RuntimePhase, alreadySelected = false): SessionOpenAction {
    return alreadySelected && phase !== "stopped" && phase !== "failed" ? "none" : "activate-runtime";
}

export function spinupDetail(elapsedMilliseconds: number): string {
    if (elapsedMilliseconds < 5_000) {
        return "Starting the local Pi runtime and restoring the selected session.";
    }

    if (elapsedMilliseconds < 15_000) {
        return "Startup is slower than expected. Waiting for Pi and its installed extensions to become responsive.";
    }

    return "Startup is unusually slow. Older SpecPi Command Guard installs can impose a 30-second RPC timeout; update SpecPi if this repeats.";
}

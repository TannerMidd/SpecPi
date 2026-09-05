import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { registerNativeDelegation } from "./native.mjs";

export default function (pi: ExtensionAPI) {
    registerNativeDelegation(pi, { ...sdk, clampThinkingLevel });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNativeDelegation } from "./native.mjs";

export default function (pi: ExtensionAPI) {
    registerNativeDelegation(pi);
}

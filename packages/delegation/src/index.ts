import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { registerNativeDelegation, withPiCompatibility } from "./native.mjs";

export default async function (pi: ExtensionAPI) {
    const compatibleSdk = await withPiCompatibility(sdk, () => import("@earendil-works/pi-ai/compat"));
    registerNativeDelegation(pi, compatibleSdk, { truncateToWidth, wrapTextWithAnsi });
}

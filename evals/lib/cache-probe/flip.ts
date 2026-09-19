// Phase 7 fixture, arm B. Not a SpecPi extension: it is never installed, never published, and
// exists only to be copied into one attempt's disposable agent directory by the `probe-flip`
// harness in scripts/eval-harnesses.mjs.
//
// The question it exists to answer is narrow. SpecPi's whole "no mid-session tool-set change" rule
// rests on the claim that adding tool schemas partway through a session throws away the provider's
// cached prompt prefix, which turns the bulk of spend from cache reads into fresh input. That is
// believed and reasoned about everywhere in this repository and has never been measured here.
//
// Measuring it through `/browser on` or `request_capability` would measure the policy instead: both
// need a human, and the runner is unattended. So this flips the active tool set directly, at a
// fixed turn, with no dialog and no judgement, which isolates the mechanism. Pi's own documentation
// says the fallback path "may invalidate the provider's cached prompt prefix" — this is the
// experiment that says by how much.
//
// It only ever adds. Pi treats a purely additive change as the deferred-loading case and anything
// else as a wholesale replacement, and the two have different cache stories; the rule under test is
// about the additive one, so a removal here would answer a question nobody asked.

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Read off the recorded runs: t3-cascade-ledger's prefix is past 20k tokens by request 6, so a
// flip here has a large warm prefix to lose. Earlier and there is nothing to invalidate; later and
// too few requests remain to see the re-warm.
const FLIP_TURN = Number.parseInt(process.env.SPECPI_PROBE_FLIP_TURN ?? "6", 10);

// Named by prefix rather than listed, so the fixture does not carry a copy of the pinned package's
// tool list that could drift away from what is actually installed.
const PREFIX = process.env.SPECPI_PROBE_TOOL_PREFIX ?? "browser_";

export default function cacheProbeFlip(pi: ExtensionAPI) {
    let flipped = false;

    pi.on("turn_start", (event: any) => {
        if (flipped || event?.turnIndex !== FLIP_TURN) {
            return;
        }

        if (typeof pi.getAllTools !== "function" || typeof pi.setActiveTools !== "function") {
            return;
        }

        const active = pi.getActiveTools();
        const known = new Set(active);
        const added = pi
            .getAllTools()
            .map((tool: any) => tool?.name)
            .filter((name: unknown): name is string => typeof name === "string" && name.startsWith(PREFIX))
            .filter((name: string) => !known.has(name));
        // A flip that added nothing is not a control, it is a silent no-result. Say so on stderr,
        // which the runner already keeps as stderrTail, so the arm cannot be read as a measurement
        // of zero cost when it never fired.
        if (added.length === 0) {
            console.error(`[cache-probe] turn ${FLIP_TURN}: no inactive ${PREFIX}* tools to add`);

            return;
        }

        flipped = true;
        pi.setActiveTools([...active, ...added]);
        console.error(`[cache-probe] turn ${FLIP_TURN}: added ${added.length} tools (${added.join(", ")})`);
    });
}

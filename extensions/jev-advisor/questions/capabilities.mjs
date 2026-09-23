// System 6: decide, once, before the first provider request, whether this session is going to need
// a withdrawn tool group -- and if so, offer it then rather than in the middle.
//
// This is permitted by the standing rule because it is a once-per-session decision made before the
// first request, which is one of the three cache-safe shapes. It is also distinct from the tool
// router this project rejected: that rejection was about six tools whose usefulness local state can
// already determine from wishlist and goal state. "Will this task need a browser" is not in local
// state, and no amount of inspecting the repository answers it.
//
// It exists because Phase 7 measured what the rejection was always assumed to be worth. Flipping
// Browser QA on at turn 6 of `t3-cascade-ledger` collapsed cached tokens to 3,200 at the next
// request in three attempts out of three, while the prompt kept climbing, and the re-warm cost 20%
// of the attempt on average. Arming the same group from the first request cost 16% more than never
// arming it, against 47% for flipping mid-session. Paying up front is about three times cheaper
// than paying when the need appears -- so the whole value of this system is moving the decision
// earlier, and that is all it does.
//
// It holds no authority. It activates nothing on its own: it pre-fills the same confirmation the
// human would have seen from `request_capability`, at turn 0 instead of turn 6. A decline is
// remembered for the session, and with no interactive human it proposes nothing at all.

import { noul } from "../client.mjs";
import { nounTrue } from "../gate.mjs";
import { compact } from "../sanitize.mjs";

/**
 * Cheap, local, and checked before anything is sent. The rule is ask local state first, and while
 * local state cannot answer "will this need a browser", it answers "is that question worth asking":
 * a task with no web signal in its wording and a repository with no web assets is not one.
 */
const PROMPT_SIGNALS =
    /\b(https?:\/\/|www\.|url|link|page|site|website|web|browser|render|screenshot|accessibility|a11y|css|dom|localhost|search online|look .{0,12}up)\b/iu;

/** Names that mean this repository has something a browser could open. */
const WEB_ASSETS = /^(index\.html|.*\.html?|vite\.config\..*|next\.config\..*|svelte\.config\..*|astro\.config\..*)$/iu;

export function promptSignal(prompt) {
    return PROMPT_SIGNALS.test(String(prompt ?? ""));
}

/** One bounded readdir of the working directory. Never recursive: this is a hint, not a survey. */
export function repositorySignal(entries) {
    return (entries ?? []).slice(0, 200).some((name) => WEB_ASSETS.test(String(name)));
}

export function localSignals({ prompt, entries }) {
    const reasons = [];
    if (promptSignal(prompt)) {
        reasons.push("prompt-mentions-web");
    }

    if (repositorySignal(entries)) {
        reasons.push("repository-has-web-assets");
    }

    return { ask: reasons.length > 0, reasons };
}

/**
 * The prompt is the one place in this layer where the user's own words are sent rather than a
 * digest of them, and it is bounded hard for that reason. It is the only thing that can answer the
 * question, and it is one message rather than a transcript.
 */
export function buildInput({ prompt, reasons, available, cwdEntries = [] }) {
    return {
        request: compact(prompt ?? "", 400),
        reasons,
        withdrawnGroups: available,
        workspaceFiles: cwdEntries.slice(0, 12).map((name) => compact(name, 40)),
    };
}

export function questions({ available = [] } = {}) {
    const asked = {};
    if (available.includes("web")) {
        asked.needs_web = noul("Completing this request will require searching the web or fetching an external page");
    }

    if (available.includes("browser")) {
        asked.needs_browser = noul(
            "Completing this request will require opening a page in a browser to check how it renders or behaves",
        );
    }

    // Asked whenever the session is capable of it, because the answer is a suggestion to the human
    // rather than an activation: delegation binds a model and a host and needs its own command.
    asked.needs_delegation = noul(
        "This request would be better answered by reading a large set of files than by reasoning about a few",
    );

    return asked;
}

/**
 * Deliberately asymmetric. A false positive costs the group's schema on every request for the rest
 * of the session and a confirmation the human did not need; a false negative costs nothing at all,
 * because it leaves today's behaviour exactly as it is and `request_capability` is still there. So
 * this proposes only on a high bar, and the `capability` thresholds are the strictest in the layer.
 */
export function decide(answers, available = []) {
    const propose = [];
    if (available.includes("web") && nounTrue(answers?.needs_web, "capability")) {
        propose.push("web");
    }

    if (available.includes("browser") && nounTrue(answers?.needs_browser, "capability")) {
        propose.push("browser");
    }

    return {
        propose,
        suggestDelegation: nounTrue(answers?.needs_delegation, "capability"),
    };
}

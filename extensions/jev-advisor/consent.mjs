// A config flag records an intention. It does not record that a human was told what the intention
// costs. This file holds the separate, explicit grant: the first time any system would put session
// state on the wire, a dialog names the endpoint, the shape of the data and the byte budget, and
// nothing is sent until someone says yes.
//
// Mirrors capability-policy: SpecPi's own file, atomic, mode 0600, symlinks refused, missing or
// unreadable read as "ask". No interactive UI means no send, ever.

import fs from "node:fs";
import path from "node:path";
import { jevDirectory, regularFile, writeFileAtomic } from "./config.mjs";
import { baseUrl } from "./client.mjs";
import { MAX_STATE_BYTES } from "./sanitize.mjs";

/**
 * The host the bytes will actually reach, not the service they are nominally for. This was a fixed
 * "api.typesafe.ai" until the default backend became OpenRouter, at which point the dialog named a
 * host the data no longer went to, which is the one thing a consent dialog may never do. It is
 * derived now, so each of the three selectable destinations (OpenRouter, the direct TypeSafe API,
 * and a TYPESAFE_BASE_URL override) names itself, and so the rule below is true rather than
 * aspirational: a grant is keyed on this string, so repointing the client really does ask again.
 */
export const CONSENT_SCHEMA = 2;

export function endpointOrigin() {
    return new URL(baseUrl()).origin;
}

export function endpointLabel() {
    const base = baseUrl();
    try {
        return new URL(base).host;
    } catch {
        // Unparseable means the fetch will fail anyway. Returning the raw value keeps the dialog
        // honest and cannot collide with a host a real grant was given for.
        return base;
    }
}

function consentFile() {
    return path.join(jevDirectory(), "consent.json");
}

export function loadConsent() {
    try {
        const file = consentFile();
        if (!regularFile(file, "Jev consent")) {
            return undefined;
        }

        const stored = JSON.parse(fs.readFileSync(file, "utf8"));
        if (stored?.schema !== CONSENT_SCHEMA || stored.granted !== true || typeof stored.endpoint !== "string") {
            return undefined;
        }

        // A grant is for the endpoint it was given for. Repointing the client asks again.
        return stored.endpoint === endpointLabel() && stored.origin === endpointOrigin() ? stored : undefined;
    } catch {
        return undefined;
    }
}

export function granted() {
    return loadConsent() !== undefined;
}

export function saveConsent() {
    const file = consentFile();
    if (fs.existsSync(file)) {
        regularFile(file, "Jev consent");
    }

    const stored = {
        // Earlier consent incorrectly excluded file/command samples. It cannot authorize them.
        schema: CONSENT_SCHEMA,
        granted: true,
        endpoint: endpointLabel(),
        origin: endpointOrigin(),
        maxStateBytes: MAX_STATE_BYTES,
        grantedAt: new Date().toISOString(),
    };
    writeFileAtomic(file, `${JSON.stringify(stored, null, 4)}\n`);

    return stored;
}

export function revokeConsent() {
    try {
        fs.rmSync(consentFile(), { force: true });
    } catch {
        // A consent file that cannot be removed still reads as granted; the master switch is the
        // reliable stop, and /jev status reports both.
    }
}

export function consentPath() {
    return consentFile();
}

export const CONSENT_TITLE = "Allow SpecPi to send task summaries and text samples to Jev?";

export function consentBody(systemLabel) {
    return [
        `${systemLabel} wants to ask TypeSafe's Jev classifier a question about this session.`,
        "",
        `What is sent: a state object of at most ${MAX_STATE_BYTES} bytes to ${endpointLabel()}, with classifier questions.`,
        `Transport: ${new URL(baseUrl()).protocol === "https:" ? "HTTPS" : "not HTTPS (configured endpoint override)"}.`,
        "It may include the current request or objective, relative paths, capability-gap summaries,",
        "and short sampled lines from file contents, command output and fetched content.",
        "Known credential, email, URL and outside-workspace path patterns are redacted before sending.",
        "Redaction is best effort, not a guarantee that every sensitive detail is removed. No session history is read.",
        "Collection stays local unless you separately allow this advisor transmission.",
        "",
        "Every call is recorded locally in transmissions.jsonl with a hash of exactly what was sent,",
        "which you can read with /jev ledger. Turn this off at any time with /jev off.",
    ].join("\n");
}

/**
 * Resolve consent for a system, prompting once. Returns false without prompting when there is no
 * interactive human: an advisor must never be the reason a headless run sends data.
 */
export async function ensureConsent(ctx, systemLabel) {
    if (granted()) {
        return true;
    }

    if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
        return false;
    }

    const accepted = await ctx.ui.confirm(CONSENT_TITLE, consentBody(systemLabel));
    if (!accepted) {
        return false;
    }

    try {
        saveConsent();
    } catch {
        // An unwritable grant means asking again next time, which is the safe direction.
        return true;
    }

    return true;
}

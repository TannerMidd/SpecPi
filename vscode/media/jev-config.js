((root) => {
    // Configuration shape reviewed against extensions/jev-advisor/config.mjs.
    //
    // The Jev layer ships entirely off, and every switch here is a way to turn part of it on, so
    // this file is the one place Chat can start sending session summaries to a third party. It
    // holds no credential: the key comes from the environment Pi was started with and Chat never
    // reads, writes or displays it.
    //
    // Two shapes, deliberately. On disk the four systems are nested under `systems` and the guard
    // under `guard`, because the advisor and the guard are separate packages with separate gates.
    // In the form they are flat booleans, because a nested object renders as a JSON textarea and
    // the point of this panel is a toggle. `fromStored`/`toStored` are the only translation, and
    // both directions are total so a round trip cannot silently drop a key.

    const SYSTEMS = ["retention", "compaction", "gap", "sources"];
    const MAX_CALL_BUDGET = 64;
    const DEFAULT_CALL_BUDGET = 8;

    // [key, label, type, help]. Order is the order the panel renders.
    const fields = [
        [
            "master",
            "Jev layer enabled (this session)",
            "boolean",
            "Master switch. While this is off nothing is sent, no key is read, and the harness behaves exactly as it did before the layer existed.",
        ],
        [
            "startup",
            "Enable the Jev layer on startup",
            "boolean",
            "Default the master switch on for new sessions. A session toggle never writes this preference.",
        ],
        [
            "retention",
            "System: shorten spent tool results",
            "boolean",
            "Decides whether a large read-only result is still worth carrying, before it is appended. Code does the shortening, so no model-written text enters the transcript.",
        ],
        [
            "compaction",
            "System: steer compaction",
            "boolean",
            "Adds guidance at the one boundary where the prompt cache is discarded anyway, so it costs no extra cache invalidation.",
        ],
        [
            "gap",
            "System: cluster capability gaps",
            "boolean",
            "Groups capability-gap reports that describe the same friction and scores their impact independently of what the report claimed.",
        ],
        [
            "sources",
            "System: order delegation sources",
            "boolean",
            "Orders the sources a delegation batch will freeze. It only ever reorders; it never drops one.",
        ],
        [
            "callBudgetPerSession",
            "Calls per session",
            "number",
            `Hard ceiling on Jev calls in one session, 0 to ${MAX_CALL_BUDGET}. Reaching it stops further calls for the session rather than degrading quietly.`,
        ],
        [
            "guardEnabled",
            "Command guard enabled (this session)",
            "boolean",
            "Lets specpi-jev-guard score shell and file calls before the permission system sees them. It is fail-closed: with no key, an unreachable endpoint, or an uncertain verdict and no UI, it blocks the call.",
        ],
        [
            "guardStartup",
            "Enable the command guard on startup",
            "boolean",
            "Default the guard on for new sessions. While it is off, @gotgenes/pi-permission-system decides every call exactly as before.",
        ],
    ];

    function object(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /** Disk shape to form shape. Anything unrecognised reads as off, never as a partial enable. */
    function fromStored(stored) {
        const source = object(stored) ? stored : {};
        const systems = object(source.systems) ? source.systems : {};
        const guard = object(source.guard) ? source.guard : {};
        const budget = Number.isSafeInteger(source.callBudgetPerSession)
            ? Math.min(Math.max(source.callBudgetPerSession, 0), MAX_CALL_BUDGET)
            : DEFAULT_CALL_BUDGET;
        const flat = {
            master: source.master === true,
            startup: source.startup === true,
            callBudgetPerSession: budget,
            guardEnabled: guard.enabled === true,
            guardStartup: guard.startup === true,
        };
        for (const name of SYSTEMS) {
            flat[name] = systems[name] === true;
        }

        return flat;
    }

    /** Form shape back to disk shape, including the schema marker the extension requires. */
    function toStored(flat) {
        const source = object(flat) ? flat : {};

        return {
            schema: 1,
            master: source.master === true,
            startup: source.startup === true,
            systems: Object.fromEntries(SYSTEMS.map((name) => [name, source[name] === true])),
            callBudgetPerSession: Number.isSafeInteger(source.callBudgetPerSession)
                ? Math.min(Math.max(source.callBudgetPerSession, 0), MAX_CALL_BUDGET)
                : DEFAULT_CALL_BUDGET,
            guard: { enabled: source.guardEnabled === true, startup: source.guardStartup === true },
        };
    }

    function parse(text) {
        const value = JSON.parse(text);
        if (!object(value)) {
            throw new Error("Jev settings must be a JSON object.");
        }

        return value;
    }

    // Validated in the webview so the form can refuse a bad draft, and again in the host so it
    // never trusts the view. An unknown key is reported rather than written: the advisor collapses
    // an unrecognised shape to all-off, so silently keeping one would turn the layer off later
    // without saying so.
    function validate(text) {
        const config = parse(text);
        const unknown = [];
        const known = new Set(fields.map(([key]) => key));
        for (const key of Object.keys(config)) {
            if (!known.has(key)) {
                unknown.push(key);
                continue;
            }

            const [, , type] = fields.find(([name]) => name === key);
            if (type === "boolean" && typeof config[key] !== "boolean") {
                throw new Error(`${key} must be true or false.`);
            }

            if (type === "number") {
                const value = config[key];
                if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CALL_BUDGET) {
                    throw new Error(`${key} must be a whole number from 0 to ${MAX_CALL_BUDGET}.`);
                }
            }
        }

        return { config, unknown };
    }

    const api = { SYSTEMS, MAX_CALL_BUDGET, DEFAULT_CALL_BUDGET, fields, parse, validate, fromStored, toStored };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.SpecPiJevConfig = api;
    }
})(typeof window === "undefined" ? globalThis : window);

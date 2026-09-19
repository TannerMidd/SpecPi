((root) => {
    // Configuration shape reviewed against extensions/jev-advisor/config.mjs.
    //
    // The Jev layer ships entirely off, and every switch here is a way to turn part of it on, so
    // this file is the one place Chat can start sending session summaries to a third party. It
    // holds no credential: the key comes from the environment Pi was started with and Chat never
    // reads, writes or displays it.
    //
    // Two shapes, deliberately. On disk the systems are nested under `systems`, the budgets
    // under `budgets` and the guard under `guard`, because the advisor and the guard are separate
    // packages with separate gates. In the form they are flat, because a nested object renders as a
    // JSON textarea and the point of this panel is a toggle. `fromStored`/`toStored` are the only
    // translation, and both directions are total so a round trip cannot silently drop a key.

    const SYSTEMS = ["retention", "compaction", "gap", "sources", "progress", "untrusted", "capability"];
    const MAX_CALL_BUDGET = 64;
    const MAX_TOTAL_BUDGET = 128;
    const NUDGE_MODES = ["notify", "message"];
    // Must equal DEFAULT_BUDGETS in extensions/jev-advisor/config.mjs; a test pins them together,
    // because a panel whose defaults differ from the advisor's writes a change on every save.
    const DEFAULT_BUDGETS = {
        total: 30,
        retention: 12,
        compaction: 3,
        gap: 6,
        sources: 4,
        progress: 12,
        untrusted: 8,
        capability: 2,
    };
    const BUDGET_KEYS = { total: "budgetTotal" };
    for (const name of SYSTEMS) {
        BUDGET_KEYS[name] = `budget${name[0].toUpperCase()}${name.slice(1)}`;
    }

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
            "Decides whether a large read-only result is still worth carrying, before it is appended. Covers reads, searches, shell output, fetched pages, browser snapshots and delegation reports. Code does the shortening, so no model-written text enters the transcript.",
        ],
        [
            "compaction",
            "System: steer compaction and branch summaries",
            "boolean",
            "Adds guidance at the two boundaries where the prompt cache is discarded anyway, so it costs no extra cache invalidation, and labels abandoned branches from a fixed list so the session tree stays navigable.",
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
            "Orders the sources a delegation batch will freeze, and warns when the question does not look like one a read-only child could answer. It only ever reorders; it never drops one.",
        ],
        [
            "progress",
            "System: notice a stuck session",
            "boolean",
            "Watches for a session that has stopped making progress -- a repeated tool call, a run of errors, or several turns with no file changed -- and asks Jev whether it is stuck. It only ever asks after local signals already say something is wrong.",
        ],
        [
            "untrusted",
            "System: flag fetched content that talks to the agent",
            "boolean",
            "Asks whether a fetched page or browser snapshot contains instructions aimed at an AI reading it, and prepends a fixed warning line when it confidently does. Defence in depth: it never blocks, never touches the agent's own output, and costs no extra call while the retention system is also on.",
        ],
        [
            "capability",
            "System: arm a withdrawn tool group before the first request",
            "boolean",
            "Reads the request itself, once, before anything is sent to the model, and offers a withdrawn tool group when it is confident the task will need one. It activates nothing: you still confirm, and declining is remembered for the session. Accepting at turn 0 is measurably cheaper than accepting later, because a mid-session activation also discards the cached prompt prefix.",
        ],
        [
            "progressNudge",
            "What a stuck verdict may do",
            "string",
            'Either "notify" (tell the person, which cannot change what the model does) or "message" (append a fixed line the model reads before its next request). It ships on "notify" because the calibration corpus does not yet show a mid-session verdict is reliable enough to steer a model with.',
        ],
        [
            BUDGET_KEYS.total,
            "Calls per session, all systems",
            "number",
            `Hard ceiling on Jev calls in one session, 0 to ${MAX_TOTAL_BUDGET}. It is deliberately below the sum of the per-system ceilings, so it is a real constraint. Reaching it stops further calls for the session rather than degrading quietly.`,
        ],
        ...SYSTEMS.map((name) => [
            BUDGET_KEYS[name],
            `Calls per session, ${name}`,
            "number",
            `Ceiling for the ${name} system alone, 0 to ${MAX_CALL_BUDGET}. Per-system ceilings exist so one busy system cannot starve the others; 0 means no calls, and switching the system off above is the way to disable it.`,
        ]),
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

    function budget(value, fallback, ceiling) {
        return Number.isSafeInteger(value) ? Math.min(Math.max(value, 0), ceiling) : fallback;
    }

    /**
     * Disk shape to form shape. Anything unrecognised reads as off, never as a partial enable.
     *
     * Schema 1 is migrated here rather than treated as unrecognised, mirroring `migrate()` in
     * extensions/jev-advisor/config.mjs exactly. If the panel showed defaults where the advisor
     * migrates, opening the panel and pressing save would silently replace a ceiling the user
     * chose with the one we ship. A test loads the same file through both and compares.
     */
    function fromStored(stored) {
        const source = object(stored) ? stored : {};
        const systems = object(source.systems) ? source.systems : {};
        const guard = object(source.guard) ? source.guard : {};
        const budgets = object(source.budgets) ? source.budgets : {};
        // Schema 1 read 0 as "no ceiling"; schema 2 reads it as "no calls".
        const legacy = source.schema === 1;
        const stale = source.callBudgetPerSession === 0 ? MAX_TOTAL_BUDGET : source.callBudgetPerSession;
        const total = legacy
            ? budget(stale, DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET)
            : budget(budgets.total, DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET);
        const flat = {
            master: source.master === true,
            startup: source.startup === true,
            progressNudge: NUDGE_MODES.includes(source.progressNudge) ? source.progressNudge : "notify",
            [BUDGET_KEYS.total]: total,
            guardEnabled: guard.enabled === true,
            guardStartup: guard.startup === true,
        };
        for (const name of SYSTEMS) {
            flat[name] = systems[name] === true;
            flat[BUDGET_KEYS[name]] = legacy
                ? Math.min(DEFAULT_BUDGETS[name], total)
                : budget(budgets[name], DEFAULT_BUDGETS[name], MAX_CALL_BUDGET);
        }

        return flat;
    }

    /** Form shape back to disk shape, including the schema marker the extension requires. */
    function toStored(flat) {
        const source = object(flat) ? flat : {};
        const budgets = { total: budget(source[BUDGET_KEYS.total], DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET) };
        for (const name of SYSTEMS) {
            budgets[name] = budget(source[BUDGET_KEYS[name]], DEFAULT_BUDGETS[name], MAX_CALL_BUDGET);
        }

        return {
            schema: 2,
            master: source.master === true,
            startup: source.startup === true,
            systems: Object.fromEntries(SYSTEMS.map((name) => [name, source[name] === true])),
            budgets,
            progressNudge: NUDGE_MODES.includes(source.progressNudge) ? source.progressNudge : "notify",
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
                const ceiling = key === BUDGET_KEYS.total ? MAX_TOTAL_BUDGET : MAX_CALL_BUDGET;
                const value = config[key];
                if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
                    throw new Error(`${key} must be a whole number from 0 to ${ceiling}.`);
                }
            }

            // The advisor falls back to "notify" for anything it does not recognise, so an
            // unchecked typo here would read as a quieter setting than the person chose and never
            // say so. Refusing it is the difference between a default and a silent downgrade.
            if (type === "string" && !NUDGE_MODES.includes(config[key])) {
                throw new Error(`${key} must be one of: ${NUDGE_MODES.join(", ")}.`);
            }
        }

        return { config, unknown };
    }

    const api = {
        SYSTEMS,
        MAX_CALL_BUDGET,
        MAX_TOTAL_BUDGET,
        NUDGE_MODES,
        DEFAULT_BUDGETS,
        BUDGET_KEYS,
        fields,
        parse,
        validate,
        fromStored,
        toStored,
    };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.SpecPiJevConfig = api;
    }
})(typeof window === "undefined" ? globalThis : window);

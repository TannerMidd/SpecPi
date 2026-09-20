((root) => {
    // Configuration shape reviewed against extensions/jev-advisor/config.mjs (schema 5).
    //
    // The Jev layer ships entirely off, and every switch here is a way to turn part of it on, so
    // this file is the one place Chat can start sending session summaries to a third party. It
    // holds no credential: the key comes from the environment Pi was started with and Chat never
    // reads, writes or displays it.
    //
    // Two shapes, deliberately. On disk the systems are nested under `systems` and the budgets under
    // `budgets`; in the form they are flat, because a nested object renders as a JSON textarea and
    // the point of this panel is a toggle. `fromStored`/`toStored` are the only translation, and both
    // directions are total so a round trip cannot silently drop a key.
    //
    // The command guard is not here, and not in the file either. It is a separate pinned package
    // that keeps its own configuration and its own switch, so schema 4 carried no trace of it: the
    // `guard` pair schema 2 held and the `systems.guard` entry schema 3 held are both read past and
    // not written back. Neither was ever the authority -- the package's own file is -- so dropping
    // them changes nothing about whether anyone's guard is on.
    //
    // Compaction guidance is not here either. Schema 5 removed it after two tier-6 runs measured the
    // arm carrying it solving fewer long-session tasks than plain SpecPi, and a stored
    // `systems.compaction` is read past for the same reason the guard keys are: the hooks it gated
    // no longer exist, so the preference could only describe a system that cannot run.

    const SYSTEMS = ["retention", "gap", "sources", "progress", "untrusted", "capability"];
    const MAX_CALL_BUDGET = 1024;
    const MAX_TOTAL_BUDGET = 2048;
    const NUDGE_MODES = ["notify", "message"];
    // Must equal DEFAULT_BUDGETS in extensions/jev-advisor/config.mjs; a test pins them together,
    // because a panel whose defaults differ from the advisor's writes a change on every save.
    const DEFAULT_BUDGETS = {
        total: 2048,
        retention: 832,
        gap: 192,
        sources: 128,
        progress: 704,
        untrusted: 416,
        capability: 2,
    };
    // The label a row gets in the usage table. Same names the advisor prints in /jev status, so a
    // person reading both does not have to work out that two words mean one system.
    const SYSTEM_LABELS = {
        retention: "Tool-result retention",
        gap: "Capability-gap triage",
        sources: "Delegation source ranking",
        progress: "Progress and thrash detection",
        untrusted: "Untrusted-content classification",
        capability: "Turn-zero capability arming",
    };
    const BUDGET_KEYS = { total: "budgetTotal" };
    for (const name of SYSTEMS) {
        BUDGET_KEYS[name] = `budget${name[0].toUpperCase()}${name.slice(1)}`;
    }

    // [key, label, type, help]. Order is the order the panel renders.
    const fields = [
        [
            "enabled",
            "Jev layer enabled",
            "boolean",
            "The one switch. While it is off nothing is sent, no key is read, and the harness behaves exactly as it did before the layer existed. Turning it on here enables every system below that is currently off, because a layer with no systems on is a switch that does nothing. Pi reads this when a session starts, so restart Pi after saving.",
        ],
        [
            "retention",
            "System: shorten spent tool results",
            "boolean",
            "Decides whether a large read-only result is still worth carrying, before it is appended. Covers reads, searches, shell output, fetched pages, browser snapshots and delegation reports. Code does the shortening, so no model-written text enters the transcript.",
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
        const budgets = object(source.budgets) ? source.budgets : {};
        // Schema 1 read 0 as "no ceiling"; schema 2 reads it as "no calls".
        const legacy = source.schema === 1;
        const stale = source.callBudgetPerSession === 0 ? MAX_TOTAL_BUDGET : source.callBudgetPerSession;
        const total = legacy
            ? budget(stale, DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET)
            : budget(budgets.total, DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET);
        const flat = {
            // `master` and `startup` are two stored keys for one intention, and the advisor only
            // acts when both are true: `session_start` zeroes a stored master whenever startup is
            // false. A panel that showed them as independent checkboxes was therefore offering a
            // combination -- on, but not at startup -- that describes a layer which is never on at
            // all. The panel shows the effective state and writes both together.
            enabled: source.master === true && source.startup === true,
            progressNudge: NUDGE_MODES.includes(source.progressNudge) ? source.progressNudge : "notify",
            [BUDGET_KEYS.total]: total,
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

        const enabled = source.enabled === true;

        return {
            schema: 5,
            // Always written together; see `fromStored`. Keeping them in step is what makes the
            // checkbox mean what it says in the next session rather than only in this file.
            master: enabled,
            startup: enabled,
            systems: Object.fromEntries(SYSTEMS.map((name) => [name, source[name] === true])),
            budgets,
            progressNudge: NUDGE_MODES.includes(source.progressNudge) ? source.progressNudge : "notify",
        };
    }

    /**
     * Enabling the layer has to enable something.
     *
     * Every system ships off, so a fresh file with the layer switched on describes a layer that
     * runs and does nothing -- which is exactly the state people kept arriving at, because nothing
     * in the panel said that six more boxes were load-bearing. This fills them in on the
     * transition from off to on, and only when none are already on: a person running retention
     * alone has chosen that, and toggling the layer must not quietly hand back the other six.
     *
     * It deliberately runs in the form rather than in `toStored`, so the boxes visibly tick before
     * anything is saved. A save that silently rewrote seven settings the person never touched would
     * buy the same behaviour at the cost of trusting the panel.
     */
    function couple(config, previous) {
        // Three cases, and the third is the one that was missing. Turning the layer on fills the
        // systems in; a file that arrives already on with nothing running is the broken state this
        // panel exists to repair, and it is repaired the same way. But a person unticking the last
        // system in a working file has not arrived at either: they have said "none of these", and
        // re-ticking all seven answered a deliberate act by undoing it, with a note describing a
        // file that never existed. The advisor's own `/jev disable` reads the same situation as
        // "switch the layer off", so this does too.
        if (!deadLayer(config)) {
            return { config, note: "" };
        }

        if (previous?.enabled === true && !deadLayer(previous)) {
            return {
                config: { ...config, enabled: false },
                note: " That was the last system, so the layer was switched off; it would otherwise run and do nothing.",
            };
        }

        const arriving = previous?.enabled !== true;
        const next = { ...config };
        for (const name of SYSTEMS) {
            next[name] = true;
        }

        return {
            config: next,
            note: arriving
                ? ` All ${SYSTEMS.length} systems were switched on with the layer; turn any back off before saving.`
                : ` This file had the layer on with every system off, which runs and does nothing. All ${SYSTEMS.length} were switched on; turn any back off before saving.`,
        };
    }

    function counter(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }

    function timestamp(value) {
        return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : "";
    }

    /**
     * The advisor's own running count, from <agent-dir>/specpi/jev/usage.json. It is counts and
     * nothing else -- no state, no answers, no digests -- which is what makes it safe for a second
     * process to read at all, and the normaliser here is total so a truncated or half-written file
     * shows as absent rather than as a session that made no calls.
     *
     * Returns undefined for any shape this version does not know, including a missing file. The
     * panel renders that as "the layer has not run", which is the honest reading: the advisor only
     * writes this file once the layer is on.
     */
    function fromStoredUsage(raw) {
        if (!object(raw) || raw.schema !== 1) {
            return undefined;
        }

        const systems = {};
        for (const name of SYSTEMS) {
            const bucket = object(raw.systems) && object(raw.systems[name]) ? raw.systems[name] : {};
            systems[name] = {
                calls: counter(bucket.calls),
                applied: counter(bucket.applied),
                failed: counter(bucket.failed),
                savedBytes: counter(bucket.savedBytes),
            };
        }

        const budgets = object(raw.budgets) ? raw.budgets : {};

        return {
            session: typeof raw.session === "string" ? raw.session.slice(0, 64) : "",
            startedAt: timestamp(raw.startedAt),
            updatedAt: timestamp(raw.updatedAt),
            active: raw.active === true,
            calls: counter(raw.calls),
            budgets: {
                total: counter(budgets.total),
                ...Object.fromEntries(SYSTEMS.map((name) => [name, counter(budgets[name])])),
            },
            systems,
        };
    }

    /**
     * One row per system plus the total, in the order the panel renders them. Systems that have
     * made no call are kept rather than filtered: "retention: 0 of 208" is the answer to "is this
     * thing doing anything", and dropping the row would leave that question unanswered.
     */
    function usageRows(usage) {
        if (!usage) {
            return [];
        }

        return [
            { name: "total", label: "All systems", calls: usage.calls, budget: usage.budgets.total, applied: null },
            ...SYSTEMS.map((name) => ({
                name,
                label: SYSTEM_LABELS[name] || name,
                calls: usage.systems[name].calls,
                budget: usage.budgets[name],
                applied: usage.systems[name].applied,
            })),
        ];
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

    /**
     * Is this a layer that is on with nothing to run?
     *
     * Deliberately *not* part of `validate`. Making it a validation error meant the panel threw
     * while merely opening a file in that state -- which is precisely the file this panel exists to
     * repair -- so it rendered red with Save disabled before the person had touched anything, and
     * `couple` skipped it because the layer was already on. The rule belongs where a write happens:
     * `couple` fixes it in the form, and the host refuses it on save.
     */
    function deadLayer(config) {
        return config.enabled === true && SYSTEMS.every((name) => config[name] !== true);
    }

    const api = {
        SYSTEMS,
        SYSTEM_LABELS,
        MAX_CALL_BUDGET,
        MAX_TOTAL_BUDGET,
        NUDGE_MODES,
        DEFAULT_BUDGETS,
        BUDGET_KEYS,
        fields,
        parse,
        validate,
        couple,
        deadLayer,
        fromStored,
        toStored,
        fromStoredUsage,
        usageRows,
    };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.SpecPiJevConfig = api;
    }
})(typeof window === "undefined" ? globalThis : window);

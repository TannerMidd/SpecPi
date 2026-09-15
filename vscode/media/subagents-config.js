((root) => {
    // Configuration shape reviewed against pi-subagents 0.67.0.
    // This validates files, not orchestration decisions; every limit, budget,
    // and authority rule stays enforced by the upstream package.
    //
    // pi-subagents reads two unrelated files. The extension config file holds
    // runtime keys at its top level; Pi settings files hold model, agent, and
    // watchdog keys under a single "subagents" object beside unrelated Pi
    // configuration that must survive every write.
    const EXTENSION = "extension";
    const SETTINGS = "settings";

    // [key, label, type, help]. `type` drives both the generated control and
    // the validator. Enumerated strings carry their options as a nested array.
    const extensionFields = [
        [
            "asyncByDefault",
            "Async by default",
            "boolean",
            "Launches run in the background when a call omits async. Default: on.",
        ],
        [
            "forceTopLevelAsync",
            "Force top-level async",
            "boolean",
            "Forces depth-0 runs into the background and skips launch UI. Default: off.",
        ],
        ["fleetView", "FleetView", "boolean", "Persistent navigable fleet panel. Default: on."],
        [
            "fleetViewPlacement",
            "FleetView placement",
            ["belowEditor", "aboveEditor"],
            "Where the persistent FleetView sits. Default: belowEditor.",
        ],
        ["asyncWidget", "Async widget", "boolean", "Under-editor widget for active background runs. Default: on."],
        [
            "inlineToolDisplay",
            "Inline tool display",
            ["rich", "summary"],
            "Chat result rows. summary keeps one stable row per call. Default: rich.",
        ],
        [
            "toolDescriptionMode",
            "Tool description mode",
            ["compact", "full", "custom"],
            "Parent-facing tool description registered at startup. Restart Pi after changing.",
        ],
        [
            "defaultSubagentContext",
            "Default context",
            ["fresh", "fork"],
            "Context for launches that omit it. Replaces per-agent defaultContext.",
        ],
        [
            "artifactDir",
            "Artifact directory",
            ["project", "session", "temp"],
            "Where inputs, outputs, transcripts, and metadata are stored. Default: session.",
        ],
        [
            "resultScanLogging",
            "Result scan logging",
            ["all", "activity", "off"],
            "How slow result-index scans are logged. Default: activity.",
        ],
        [
            "timeoutMs",
            "Run timeout (ms)",
            "number",
            "Default deadline for foreground and plain async single runs. Default: 1800000.",
        ],
        [
            "toolTimeoutMs",
            "Tool timeout (ms)",
            "number",
            "Optional hard per-tool-call deadline. Wedge protection only, not a mutation-safe boundary.",
        ],
        [
            "globalConcurrencyLimit",
            "Concurrency limit",
            "number",
            "Children running at once inside one run. Default: 20.",
        ],
        [
            "maxSubagentSpawnsPerRun",
            "Max spawns per run",
            "number",
            "Cumulative child admissions in one top-level run tree. Default: 64.",
        ],
        [
            "maxSubagentSpawnsPerSession",
            "Max spawns per session",
            "number",
            "Cumulative child launches in one parent session. 0 or unset is unlimited.",
        ],
        [
            "maxActiveAsyncRunsPerSession",
            "Max active async runs",
            "number",
            "Concurrent top-level async runs per session. 0 or unset is unlimited.",
        ],
        [
            "maxSubagentDepth",
            "Max subagent depth",
            "number",
            "Nested delegation depth when nothing stricter is inherited.",
        ],
        [
            "foregroundDetachShortcut",
            "Detach shortcut",
            "string",
            "Detaches the active foreground run without stopping it, for example ctrl+b. Unset by default.",
        ],
        [
            "defaultSessionDir",
            "Default session directory",
            "string",
            "Used before a directory derived from the parent session.",
        ],
        [
            "singleRunOutputBaseDir",
            "Single-run output directory",
            "string",
            "Routes relative /run output paths. Unset keeps them under the run artifact directory.",
        ],
        [
            "worktreeBaseDir",
            "Worktree base directory",
            "string",
            "Dedicated root for worktree runs. Cannot be combined with the worktrunk provider.",
        ],
        [
            "worktreeProvider",
            "Worktree provider",
            ["auto", "native", "worktrunk"],
            "Managed worktree allocator. Default: auto.",
        ],
        ["worktreeBranchPrefix", "Worktree branch prefix", "string", "Git ref namespace. Default: pi-subagents/."],
        [
            "worktreeSetupHook",
            "Worktree setup hook",
            "string",
            "Absolute, ~/, or repo-relative path run once per created worktree. Bare command names are rejected.",
        ],
        ["worktreeSetupHookTimeoutMs", "Setup hook timeout (ms)", "number", "Default: 30000."],
        ["parallel", "Parallel limits (JSON)", "object", "maxTasks (default 8) and concurrency (default 4)."],
        [
            "waitTool",
            "Wait tool (JSON or false)",
            "any",
            "enabled and defaultTimeoutMs for bg_wait, or false to disable.",
        ],
        ["missions", "Missions (JSON)", "object", "enabled, directory, globalIndex, globalIndexDir, retainTerminal."],
        [
            "authorityPolicy",
            "Authority policy (JSON)",
            "object",
            "Fixed action map: auto, confirm, or forbid. Confirm actions fail closed without interactive UI.",
        ],
        ["scheduledRuns", "Scheduled runs (JSON)", "object", "enabled, maxPending, storeRoot."],
        [
            "completionBatch",
            "Completion batch (JSON)",
            "object",
            "Batches quiet async completions. Failures never batch.",
        ],
        ["intercomBridge", "Intercom bridge (JSON)", "object", "mode, instructionFile, resultDelivery."],
        [
            "permissions",
            "Native child permissions (JSON)",
            "object",
            "Child tool permission rules enforced by pi-subagents, not by Permission System.",
        ],
        [
            "forkContext",
            "Fork context (JSON)",
            "object",
            "mode (full or pruned) and the model used for pruned summaries.",
        ],
        [
            "fleetKeybindings",
            "Fleet keybindings (JSON)",
            "object",
            "Per-action key arrays for the full Fleet inspector.",
        ],
        ["mainWindowRenderer", "Chat renderer (JSON)", "object", "horizontalSpacing (0-4) and compactResultMaxLines."],
        [
            "orcaProgressTabs",
            "Orca progress tabs (JSON)",
            "object",
            "Experimental Orca observer. Off by default; unsupported on Windows.",
        ],
        [
            "modelResponseAliases",
            "Model response aliases (JSON)",
            "object",
            "Your assertion that a response id identifies a requested model.",
        ],
        ["modelExclusions", "Model exclusions (JSON)", "object", "defaultTtlMs for cached model exclusions."],
        [
            "capacity",
            "Capacity policy (JSON)",
            "object",
            "abandonedSlotReleaseAfterMs, or false to keep strict retention.",
        ],
    ];

    // Everything under the "subagents" key of a Pi settings file. The writer
    // touches only this object and leaves every other Pi setting untouched.
    const settingsFields = [
        [
            "defaultModel",
            "Default model",
            "string",
            "Model for every subagent without its own. Weaker than agent frontmatter.",
        ],
        [
            "defaultProvider",
            "Default provider",
            "string",
            "Resolves bare model ids when several providers expose the same one.",
        ],
        [
            "defaultThinking",
            "Default thinking",
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            "Shared thinking level for agents without one. Project settings win over user settings.",
        ],
        [
            "maxThinking",
            "Max thinking",
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            "Hard ceiling for every native Pi child.",
        ],
        ["disableThinking", "Disable thinking", "boolean", "Clears bundled builtin thinking defaults. Default: off."],
        ["disableBuiltins", "Disable builtin agents", "boolean", "Disables every builtin agent at once. Default: off."],
        [
            "projectRootResolution",
            "Project root resolution",
            ["nearest", "git-root"],
            "git-root anchors discovery to the git worktree root. Default: nearest.",
        ],
        [
            "agentScanDirs",
            "Agent scan directories (JSON array)",
            "array",
            "Extra recursive agent roots. ~ expands; one * segment expands one level.",
        ],
        [
            "defaultExtensions",
            "Default extensions (JSON array)",
            "array",
            "Extension allowlist for agents without their own.",
        ],
        [
            "agentOverrides",
            "Agent overrides (JSON)",
            "object",
            "Per-agent model, provider, thinking, tools, skills, prompt, or enabled. Replaces matching frontmatter.",
        ],
        [
            "agentOverridesByProvider",
            "Overrides by provider (JSON)",
            "object",
            "Layers role fields for the active parent provider.",
        ],
        [
            "modelScope",
            "Model scope (JSON)",
            "object",
            "Policy only: enforce, strict, allow globs, and agents.<name>. Rejects or warns; never picks a cheaper model.",
        ],
        [
            "watchdog",
            "Watchdog (JSON)",
            "object",
            "Opt-in second model reviewing each turn: enabled, cadence, children, rules, clarification.",
        ],
    ];

    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const unsafeKey = (key) => !key || ["__proto__", "constructor", "prototype"].includes(key);

    function fieldsFor(target) {
        if (target === EXTENSION) {
            return extensionFields;
        }

        if (target === SETTINGS) {
            return settingsFields;
        }

        throw new Error("Choose the extension configuration or a Pi settings file.");
    }

    function parse(text) {
        if (typeof text !== "string" || text.length > 262144) {
            throw new Error("Configuration must be at most 256 KiB.");
        }

        // Preserve comments in the source draft; strip only for parsing. No trailing commas.
        const json = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu, (part) =>
            part.startsWith("/") ? part.replace(/[^\r\n]/gu, " ") : part,
        );
        let config;
        try {
            config = JSON.parse(json);
        } catch {
            throw new Error("Invalid JSON. Check quotes, brackets, comments, and trailing commas.");
        }

        if (!object(config)) {
            throw new Error("Configuration must be a JSON object.");
        }

        return config;
    }

    function checkValue(key, value, type, fail) {
        if (Array.isArray(type)) {
            if (typeof value !== "string" || !type.includes(value)) {
                fail(`${key} (expected one of: ${type.join(", ")})`);
            }

            return;
        }

        if (type === "boolean" && typeof value !== "boolean") {
            fail(key);
        }

        if (type === "string" && (typeof value !== "string" || value.length > 4096)) {
            fail(key);
        }

        if (type === "number" && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)) {
            fail(`${key} (expected a whole number from 0 to 2147483647)`);
        }

        if (type === "object" && !object(value)) {
            fail(key);
        }

        if (type === "array" && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))) {
            fail(key);
        }
    }

    // Known keys are checked against their documented type. Unknown keys pass
    // through with a reported note rather than a refusal: pi-subagents adds
    // configuration faster than this schema can follow, and refusing to save a
    // file the package itself accepts would be worse than a typo surviving.
    function validate(text, target) {
        const config = parse(text);
        const known = new Map(fieldsFor(target).map(([key, , type]) => [key, type]));
        const fail = (location) => {
            throw new Error(`Invalid subagents configuration at ${location}.`);
        };

        const unknown = [];
        for (const [key, value] of Object.entries(config)) {
            if (unsafeKey(key)) {
                fail(key);
            }

            const type = known.get(key);
            if (type === undefined) {
                if (key !== "$schema") {
                    unknown.push(key);
                }

                continue;
            }

            if (type !== "any") {
                checkValue(key, value, type, fail);
            }
        }

        if (target === EXTENSION && config.waitTool !== undefined) {
            if (config.waitTool !== false && !object(config.waitTool)) {
                fail("waitTool (expected an object or false)");
            }
        }

        if (target === EXTENSION && config.capacity !== undefined && config.capacity !== false) {
            const release = config.capacity.abandonedSlotReleaseAfterMs;
            if (
                release !== undefined &&
                release !== false &&
                (!Number.isSafeInteger(release) || release < 300000 || release > 86400000)
            ) {
                fail("capacity.abandonedSlotReleaseAfterMs (5 minutes through 24 hours, or false)");
            }
        }

        if (target === EXTENSION && config.mainWindowRenderer !== undefined) {
            const spacing = config.mainWindowRenderer.horizontalSpacing;
            if (spacing !== undefined && (!Number.isSafeInteger(spacing) || spacing < 0 || spacing > 4)) {
                fail("mainWindowRenderer.horizontalSpacing (0 through 4)");
            }
        }

        // enforce: true with no allow list is rejected by the package at load
        // time, which would leave Pi unable to start subagent runs at all.
        if (target === SETTINGS && config.modelScope?.enforce === true) {
            const global = Array.isArray(config.modelScope.allow) ? config.modelScope.allow : [];
            const agents = object(config.modelScope.agents) ? Object.values(config.modelScope.agents) : [];
            const scoped = agents.some((entry) => Array.isArray(entry?.allow) && entry.allow.length > 0);
            if (global.length === 0 && !scoped) {
                fail("modelScope (enforce needs at least one non-empty allow list)");
            }
        }

        for (const [name, entry] of Object.entries(target === SETTINGS ? config.agentOverrides || {} : {})) {
            if (unsafeKey(name) || !object(entry)) {
                fail(`agentOverrides.${name}`);
            }
        }

        return { config, unknown };
    }

    const api = { EXTENSION, SETTINGS, extensionFields, settingsFields, fieldsFor, parse, validate };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.SpecPiSubagentsConfig = api;
    }
})(typeof window === "undefined" ? globalThis : window);

((root) => {
    // Configuration shape reviewed against pi-permission-system 32.0.2.
    // This validates files, not permission decisions; enforcement stays upstream.
    const fields = [
        ["yoloMode", "YOLO mode", "boolean", "Auto-approve ask decisions; explicit denies still apply. Default: off."],
        [
            "permissionReviewLog",
            "Permission review log",
            "boolean",
            "Records commands without secret redaction. Default: on.",
        ],
        [
            "debugLog",
            "Debug log",
            "boolean",
            "Verbose diagnostics can contain sensitive command content. Default: off.",
        ],
        [
            "doublePressToConfirm",
            "Double-press confirmation",
            "boolean",
            "Terminal UI only; Chat approvals are unaffected. Default: on.",
        ],
        ["forwardingTimeoutMs", "Forwarding timeout (ms)", "number", "Default: 600000."],
        ["promptMaxRows", "Prompt row limit", "number", "Default: 24."],
        ["promptFieldMaxWidth", "Prompt field limit", "number", "Default: 400 characters."],
        ["reviewLogFieldMaxWidth", "Review log field limit", "number", "Default: 1000 characters; not redaction."],
        [
            "permission",
            "Permission rules (JSON)",
            "object",
            "Any tool/surface: allow, ask, deny, or an ordered pattern map. Last matching pattern wins; put catch-alls first.",
        ],
        [
            "shellTools",
            "Shell tool aliases (JSON)",
            "object",
            "Map shell tool names to commandArgument and optional workdirArgument.",
        ],
        [
            "piInfrastructureReadPaths",
            "Infrastructure read paths (JSON array)",
            "array",
            "Additional paths that bypass the external-directory read gate.",
        ],
        [
            "authorizerChain",
            "Authorizer chain (JSON array)",
            "array",
            "Ordered registered authorizer names. Naming a link grants it decision authority.",
        ],
    ];
    const decisions = new Set(["allow", "ask", "deny"]);
    const directional = new Set(["path_read", "path_write", "external_directory_read", "external_directory_write"]);
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

    function parse(text) {
        if (typeof text !== "string" || text.length > 65536) {
            throw new Error("Configuration must be at most 64 KiB.");
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

    function validate(text) {
        const config = parse(text);
        const fail = (location) => {
            throw new Error(`Invalid permission configuration at ${location}.`);
        };

        const validKey = (key) => key && !["__proto__", "constructor", "prototype"].includes(key);
        const types = new Map(fields.map(([key, , type]) => [key, type]));
        types.set("$schema", "string");
        types.set("toolInputPreviewMaxLength", "number");
        types.set("toolTextSummaryMaxLength", "number");
        for (const [key, value] of Object.entries(config)) {
            const type = types.get(key);
            if (
                !type ||
                (type === "boolean" && typeof value !== "boolean") ||
                (type === "string" && typeof value !== "string") ||
                (type === "number" && (!Number.isSafeInteger(value) || value < 1)) ||
                (type === "object" && !object(value)) ||
                (type === "array" && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)))
            ) {
                fail(key);
            }
        }

        for (const [surface, value] of Object.entries(config.permission || {})) {
            if (!validKey(surface) || (/^(path|external_directory)_/u.test(surface) && !directional.has(surface))) {
                fail(`permission.${surface}`);
            }

            if (decisions.has(value)) {
                continue;
            }

            if (!object(value)) {
                fail(`permission.${surface}`);
            }

            for (const [pattern, action] of Object.entries(value)) {
                if (!validKey(pattern)) {
                    fail(`permission.${surface} pattern`);
                }

                if (decisions.has(action)) {
                    continue;
                }

                if (
                    !object(action) ||
                    action.action !== "deny" ||
                    Object.keys(action).some((key) => !["action", "reason"].includes(key)) ||
                    (action.reason !== undefined && (typeof action.reason !== "string" || action.reason.length > 500))
                ) {
                    fail(`permission.${surface}.${pattern}`);
                }
            }
        }

        for (const [tool, alias] of Object.entries(config.shellTools || {})) {
            if (
                !validKey(tool) ||
                !object(alias) ||
                typeof alias.commandArgument !== "string" ||
                !alias.commandArgument ||
                Object.keys(alias).some((key) => !["commandArgument", "workdirArgument"].includes(key)) ||
                (alias.workdirArgument !== undefined &&
                    (typeof alias.workdirArgument !== "string" || !alias.workdirArgument))
            ) {
                fail(`shellTools.${tool}`);
            }
        }

        return config;
    }

    const api = { fields, parse, validate };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.SpecPiPermissionConfig = api;
    }
})(typeof window === "undefined" ? globalThis : window);

((root) => {
    // Configuration shape reviewed against pi-web-access 0.29.0.
    //
    // This file is a provider credential store. Chat never shows, copies, or
    // logs a configured secret: the extension host replaces every credential
    // value with REDACTED before the webview sees the file, and puts the
    // stored value back when a draft returns that same marker. A credential
    // therefore leaves disk only when the person types a replacement, and an
    // unchanged key is rewritten byte-for-byte from what was already there.
    const REDACTED = "••••••••";

    // Every provider credential field documented by pi-web-access 0.29.0.
    const credentialFields = [
        "openaiApiKey",
        "braveApiKey",
        "parallelApiKey",
        "tinyfishApiKey",
        "search1apiApiKey",
        "searchinfinityApiKey",
        "queritApiKey",
        "tavilyApiKey",
        "jinaApiKey",
        "serpdiveApiKey",
        "kagiApiKey",
        "bochaApiKey",
        "ollamaApiKey",
        "valyuApiKey",
        "serpbaseApiKey",
        "serpapiApiKey",
        "serperApiKey",
        "anysearchApiKey",
        "xcrawlApiKey",
        "xaiApiKey",
        "mistralApiKey",
        "brightdataApiKey",
        "firecrawlApiKey",
        "crawl4aiApiToken",
        "exaApiKey",
        "perplexityApiKey",
        "geminiApiKey",
        "datalabApiKey",
        "cloudflareApiKey",
    ];

    // searxngHeaders carries Cloudflare Access client secrets, so its values
    // are redacted per entry while its key names stay visible.
    const credentialMaps = ["searxngHeaders"];

    // [key, label, type, help]. Credential fields are deliberately absent:
    // they are rendered from credential status, never from a stored value.
    const fields = [
        ["provider", "Search provider", "string", "Default search provider, for example openai or brave."],
        ["searchModel", "Search model", "string", "Model used for provider searches that take one."],
        [
            "summaryModel",
            "Summary model",
            "string",
            "Accepts an optional thinking suffix, such as anthropic/claude-haiku-4-5:low.",
        ],
        ["workflow", "Workflow", "string", "Named fetch/summarise workflow, for example summary-review."],
        ["summaryGenerationDeadlineMs", "Summary deadline (ms)", "number", "Default: 30000."],
        ["maxInlineContentChars", "Max inline content", "number", "Characters of fetched content inlined into chat."],
        ["curatorTimeoutSeconds", "Curator timeout (s)", "number", "Default: 20."],
        ["autoOpenBrowser", "Auto-open browser", "boolean", "Opens curator pages in a browser automatically."],
        [
            "allowBrowserCookies",
            "Allow browser cookies",
            "boolean",
            "Lets fetches reuse a local browser profile's cookies, including logged-in sessions. Default: off.",
        ],
        ["browserCookies", "Browser cookies (JSON)", "object", "browser and profile used when cookies are allowed."],
        ["searchRouting", "Search routing (JSON)", "object", "providers, useCurrentModel, fallbackOn."],
        [
            "fetchRouting",
            "Fetch routing (JSON)",
            "object",
            "providers and allowRemoteHostedProviders. Remote providers send fetched URLs off this machine.",
        ],
        ["fetch", "Fetch options (JSON)", "object", "timeout, answerProvider, answerModel."],
        ["webSearch", "Web search (JSON)", "object", "enabled."],
        [
            "tools",
            "Tools (JSON)",
            "object",
            "Per-tool enabled flags: webSearch, sourceCheck, fetchContent, getSearchContent.",
        ],
        [
            "commands",
            "Commands (JSON)",
            "object",
            "Per-command enabled flags: websearch, curator, search, google-account.",
        ],
        ["image", "Image (JSON)", "object", "enabled."],
        ["youtube", "YouTube (JSON)", "object", "enabled and preferredModel."],
        ["video", "Video (JSON)", "object", "enabled, preferredModel, maxSizeMB."],
        ["pdf", "PDF (JSON)", "object", "enabled, maxSizeMB, provider."],
        [
            "githubClone",
            "GitHub clone (JSON)",
            "object",
            "enabled, maxRepoSizeMB, cloneTimeoutSeconds, clonePath. Clones write to this machine.",
        ],
        ["githubPrIssue", "GitHub PR/issue (JSON)", "object", "enabled."],
        [
            "fetchContent",
            "Fetch content policy (JSON)",
            "object",
            "domainPolicy.allow and domainPolicy.deny host lists.",
        ],
        [
            "ssrf",
            "SSRF policy (JSON)",
            "object",
            "allowRanges opens private address ranges to fetches; trustEnvProxy skips local DNS preflight.",
        ],
        ["shortcuts", "Shortcuts (JSON)", "object", "Key bindings for curate and activity."],
        ["curatorRemote", "Curator remote (JSON)", "object", "host and bind for a remote curator."],
        ["openaiResponsesUrl", "OpenAI responses URL", "string", "Gateway override for the OpenAI responses endpoint."],
        ["braveBaseUrl", "Brave base URL", "string", "Gateway override."],
        ["exaBaseUrl", "Exa base URL", "string", "Gateway override."],
        ["tavilyBaseUrl", "Tavily base URL", "string", "Gateway override."],
        ["searxngBaseUrl", "SearXNG base URL", "string", "Self-hosted SearXNG instance."],
        ["firecrawlBaseUrl", "Firecrawl base URL", "string", "Gateway or self-hosted override."],
        ["firecrawlApiVersion", "Firecrawl API version", "string", "For example v2."],
        ["firecrawlFreshScrape", "Firecrawl fresh scrape", "boolean", "Bypasses Firecrawl's cache."],
        ["crawl4aiBaseUrl", "Crawl4AI base URL", "string", "Self-hosted Crawl4AI instance."],
        ["geminiBaseUrl", "Gemini base URL", "string", "Gateway override."],
        ["geminiAuth", "Gemini auth", "string", "For example adc for application default credentials."],
        ["geminiProject", "Gemini project", "string", "Google Cloud project id."],
        ["geminiLocation", "Gemini location", "string", "For example us-central1."],
        ["serpdiveModel", "SerpDive model", "string", "For example krill."],
        ["mistralSearchModel", "Mistral search model", "string", "For example mistral-small-latest."],
        ["mistralSearchTool", "Mistral search tool", "string", "For example web_search."],
        ["xaiSearchTools", "xAI search tools (JSON array)", "array", 'For example ["web_search"].'],
        ["brightdataSerpZone", "BrightData SERP zone", "string", "Zone name, for example pi_serp."],
        ["brightdataUnlockerZone", "BrightData unlocker zone", "string", "Zone name, for example pi_unlocker."],
    ];

    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const unsafeKey = (key) => !key || ["__proto__", "constructor", "prototype"].includes(key);
    const isCredential = (key) => credentialFields.includes(key);

    // Describe how a credential is supplied without revealing any of it.
    // pi-web-access resolves "$NAME"/"${NAME}" from one environment variable
    // and "!command" from one trusted local command at request time.
    function credentialKind(value) {
        if (typeof value !== "string" || !value) {
            return "unset";
        }

        if (/^\$\$|^\$!/u.test(value)) {
            return "literal";
        }

        if (/^\$\{[^}]+\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
            return "environment";
        }

        if (value.startsWith("!")) {
            return "command";
        }

        return "literal";
    }

    // Replace every credential with REDACTED and report only its kind. The
    // result is what the webview is allowed to receive.
    function redact(config) {
        const safe = {};
        const credentials = {};
        for (const [key, value] of Object.entries(config)) {
            if (isCredential(key)) {
                credentials[key] = credentialKind(value);
                safe[key] = typeof value === "string" && value ? REDACTED : value;
                continue;
            }

            if (credentialMaps.includes(key) && object(value)) {
                safe[key] = Object.fromEntries(
                    Object.entries(value).map(([header, entry]) => [
                        header,
                        typeof entry === "string" && entry ? REDACTED : entry,
                    ]),
                );
                continue;
            }

            safe[key] = value;
        }

        for (const key of credentialFields) {
            if (!Object.hasOwn(credentials, key)) {
                credentials[key] = "unset";
            }
        }

        return { config: safe, credentials };
    }

    // Put stored credentials back wherever the draft returned the marker. A
    // credential the draft dropped is removed; anything else the draft carries
    // is a deliberate replacement and is written as typed.
    function restore(draft, stored) {
        const next = {};
        for (const [key, value] of Object.entries(draft)) {
            if (unsafeKey(key)) {
                throw new Error(`Invalid web access configuration at ${key}.`);
            }

            if (isCredential(key)) {
                next[key] = value === REDACTED ? stored[key] : value;
                if (next[key] === undefined) {
                    delete next[key];
                }

                continue;
            }

            if (credentialMaps.includes(key) && object(value)) {
                const source = object(stored[key]) ? stored[key] : {};
                next[key] = Object.fromEntries(
                    Object.entries(value)
                        .map(([header, entry]) => [header, entry === REDACTED ? source[header] : entry])
                        .filter(([, entry]) => entry !== undefined),
                );
                continue;
            }

            next[key] = value;
        }

        return next;
    }

    // True when the draft still carries a marker the writer must resolve. A
    // marker with nothing stored behind it would be written verbatim as a
    // credential of bullet characters, which would silently break a provider.
    function unresolved(draft, stored) {
        const missing = [];
        for (const key of credentialFields) {
            if (draft[key] === REDACTED && typeof stored[key] !== "string") {
                missing.push(key);
            }
        }

        for (const key of credentialMaps) {
            if (!object(draft[key])) {
                continue;
            }

            const source = object(stored[key]) ? stored[key] : {};
            for (const [header, entry] of Object.entries(draft[key])) {
                if (entry === REDACTED && typeof source[header] !== "string") {
                    missing.push(`${key}.${header}`);
                }
            }
        }

        return missing;
    }

    function parse(text) {
        if (typeof text !== "string" || text.length > 262144) {
            throw new Error("Configuration must be at most 256 KiB.");
        }

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

    // Known keys are checked against their documented type; unknown keys pass
    // through with a note, as pi-web-access adds providers frequently. Error
    // text names the key only, never any value, so a malformed credential
    // cannot reach a message, a log, or the webview.
    function validate(text) {
        const config = parse(text);
        const known = new Map(fields.map(([key, , type]) => [key, type]));
        const fail = (location) => {
            throw new Error(`Invalid web access configuration at ${location}.`);
        };

        const unknown = [];
        for (const [key, value] of Object.entries(config)) {
            if (unsafeKey(key)) {
                fail(key);
            }

            if (isCredential(key)) {
                if (typeof value !== "string" || value.length > 4096) {
                    fail(key);
                }

                continue;
            }

            if (credentialMaps.includes(key)) {
                if (
                    !object(value) ||
                    Object.entries(value).some(([header, entry]) => unsafeKey(header) || typeof entry !== "string")
                ) {
                    fail(key);
                }

                continue;
            }

            const type = known.get(key);
            if (type === undefined) {
                if (key !== "$schema") {
                    unknown.push(key);
                }

                continue;
            }

            if (type === "boolean" && typeof value !== "boolean") {
                fail(key);
            }

            if (type === "string" && (typeof value !== "string" || value.length > 4096)) {
                fail(key);
            }

            if (type === "number" && (!Number.isSafeInteger(value) || value < 0)) {
                fail(key);
            }

            if (type === "object" && !object(value)) {
                fail(key);
            }

            if (
                type === "array" &&
                (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
            ) {
                fail(key);
            }
        }

        return { config, unknown };
    }

    const api = {
        REDACTED,
        fields,
        credentialFields,
        credentialMaps,
        credentialKind,
        redact,
        restore,
        unresolved,
        parse,
        validate,
    };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.SpecPiWebAccessConfig = api;
    }
})(typeof window === "undefined" ? globalThis : window);

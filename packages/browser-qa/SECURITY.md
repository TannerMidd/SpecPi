# Browser QA security boundaries

This package is trusted host code running with Pi's privileges. Its isolated browser context is **not an OS sandbox, network firewall, or prompt-injection defense**. It can reach public sites, localhost, private services and metadata endpoints reachable by Chromium. HTTP(S)-only navigation is a URL restriction, not destination filtering. Do not use it on hostile pages around sensitive services without external isolation.

The extension launches an ephemeral headless Chromium context. It never attaches a personal profile, imports cookies, inspects Pi authentication, or reads provider credentials. Browser close, cancellation and session shutdown discard context and diagnostic state. Failed or stalled cleanup reports that a process may remain and requires explicit close recovery; it does not claim forced termination.

Tools can interact with real services and submit forms. This package adds no purchase, submission or file-write approval UI. The user's request and the host's permission system govern authority. `overwrite: true` is an explicit tool parameter, not independent human approval. Screenshot and baseline paths can be outside the project. Retained artifact publication uses no-clobber defaults and alias checks, but is not a general filesystem confinement mechanism or a defense against another same-user process racing files.

Screenshots, snapshots, form input and tool errors can contain sensitive information and enter Pi's conversation/model-provider boundary. Diagnostics apply **best-effort** sanitation before bounded in-memory retention: common credential patterns, authorization strings, URL credentials/query/fragment and terminal escapes are removed. Arbitrary secrets in free-form text, selectors, page content and URL paths may remain. Older click/fill/navigation error paths can contain raw Playwright diagnostics. Use dedicated test data; this is not a secret-handling browser.

No HAR, trace, telemetry or diagnostic upload is produced by this package. Explicit screenshots and baselines persist; closing the browser does not delete them or remove already returned content from Pi's conversation. Package removal leaves artifacts and the shared Playwright browser cache in place.

Setup uses the package-resolved Playwright CLI under Node, with no shell interpolation or hidden npm install hook. It downloads Chromium only on the explicit `setup` command. `--with-deps` explicitly opts into Playwright's system package installation, potentially requiring administrator access. Standard Playwright proxy/cache configuration applies. Updates and uninstall are ordinary npm/Pi package operations; this package no longer owns SpecPi's staged installer transactions.

Top-level dependency versions are exact. `package-lock.json` supports reproducible source development; ordinary published npm dependency installation does not freeze every transitive dependency. The bundled Pi manifest loads only `src/index.ts`; setup/smoke code is never auto-discovered as an extension.

Report vulnerabilities privately using the SpecPi repository's security reporting process: https://github.com/TannerMidd/SpecPi/security/advisories/new

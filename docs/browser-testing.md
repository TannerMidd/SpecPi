# Browser application testing

## Accessibility

`browser_accessibility` scans the already open isolated page using `@axe-core/playwright` and axe-core 4.13.0. Open the page, perform the relevant interaction, wait for the intended visible state, scan, repair and repeat the same scan. It does not launch a blank browser. Continue keyboard, focus and functional checks; automated results are not certification.

Optional input: `include` (CSS selector matching exactly one region), `profile` (`wcag22aa`, the default, or `best-practice` to add those checks), `maxFindings` (default 50, maximum 100 per category) and `timeoutMs` (default 15000, 1000–30000 including queueing). The WCAG profile uses `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa`. There are no custom scripts/checks, rule suppressions or exclusion lists. Invalid or ambiguous scope fails without broadening the scan.

Results separate violations and incomplete checks, identify profile/tags, scan ID/timestamps, sanitized location and viewport, and return total counts plus explicit truncation within 24 KiB. Navigation invalidates the scan. Dynamic content is not an atomic snapshot; inaccessible frames and closed shadow roots can limit coverage. No raw HTML/check payloads or automatic scan files are retained, but selectors/paths can contain sensitive data and normal results may remain in Pi history. Cancellation uses the existing browser teardown/recovery path.

The managed browser lock includes the scanner. Run `specpi update` without browser/package skip flags to provision it. Missing scanner packages affect accessibility availability; existing screenshots and browser interactions can still work. Installer/doctor extend their offline browser smoke with a known unnamed button and a corrected control, without changing the historical wishlist validator's default smoke. Real Chromium tests exercise label, contrast, ARIA and repaired dynamic states at desktop/tablet/mobile sizes.

The offline fixtures also verify unnamed controls in a same-origin iframe and an open shadow root. The closed-root control is not reported and remains an explicit coverage limitation; cross-origin frame coverage is not qualified by these fixtures. Queue expiry and cancellation discard the browser, and reopening restores scanning. These seeded-page results do not establish coverage of arbitrary applications or replace keyboard and assistive-technology review.

## Agent workflow

1. `browser_open` opens an HTTP(S) page in isolated Chromium; `browser_snapshot` exposes bounded rendered text and namespaced control references.
2. Use click/fill and the tools below to exercise the application. Refresh snapshots after mutations or navigation (including application-initiated navigation). Targets use CSS, exact `text=`, or current snapshot refs; the first matching element is used.
3. Inspect `browser_diagnostics` after navigation and interactions, wait for explicit expected states, and capture screenshots at relevant viewports. No errors alone does not establish correct behavior.
4. `browser_close` discards the context and diagnostic buffer. No personal browser profile is attached.

| Tool | Examples and limits |
| --- | --- |
| `browser_press` | `{ "key": "Tab" }`, `{ "target": "#search", "key": "Enter" }`, `{ "key": "Shift+Tab" }`. A single key/chord on the target or current focus, not a script or macro. |
| `browser_select_option` | `{ "target": "#region", "options": [{ "label": "Europe" }] }`. Each of up to 50 options specifies exactly one value, label, or index. Multiple options require a native multiple select. Custom dropdowns use click/keyboard tools. |
| `browser_wait_for` | `{ "condition": "text", "target": "#status", "text": "Saved" }`, `{ "condition": "hidden", "target": "#spinner" }`, or `{ "condition": "url", "url": "http://localhost:3000/done" }`. Element conditions: attached, detached, visible, hidden, or exact text. Text is treated literally, not as a regular expression. URL matching is exact after HTTP(S) normalization, not glob matching. |
| `browser_diagnostics` | `{ "maxEntries": 50, "maxChars": 12000 }`. Optional category: pageerror, console, requestfailed, or http; cursor for incremental reads; explicit clear. Does not launch a browser just to read an empty buffer. |

Press, selection, and waits have an operation `timeoutMs` of 5,000 by default, bounded to 1–30,000, starting at admission (including queued time). Timeouts throw instead of returning success. Cancellation, including already-aborted calls, discards diagnostics and initiates browser close; teardown settlement has an additional one-second bound. A rejected/stalled close explicitly warns that a process may remain and blocks new page operations until an explicit `browser_close` retry succeeds. After normal cleanup the next browser operation can create a fresh context. New interaction failure messages omit Playwright call logs because those logs may echo entered values or selectors. There is no arbitrary page evaluation, automatic submission retry, or sleep-only tool. Existing open/click/fill/capture timeout behavior is unchanged.

## Diagnostic evidence and privacy

Listeners attach before first navigation. The active page supplies JavaScript exceptions, error-level console messages, transport failures, and HTTP responses with status at least 400. A 404/500 response is not a transport failure; these remain separate categories. Benign console logs are not collected. Coverage is not browser-wide: popup orchestration, workers not observed by the active page, and other contexts are outside this contract. Service workers remain blocked.

The in-memory buffer retains at most 200 records, 2 KiB per serialized record, and 256 KiB total. A read returns at most 100 records and 30,000 characters of serialized JSON. Metadata reports truncation, dropped records, cursor gaps, context changes, and whether more matching records remain. Returned structured details contain no duplicate raw records. A cursor includes a context identity and sequence; navigation preserves records with navigation numbers, while close/shutdown/abort reset the identity. A cursor from an old context reports a gap, not complete coverage.

`clear: true` atomically reads and clears **all** retained records, including filtered or unreturned records; `clearedRecords` reports that count. Do not clear until needed evidence has been consumed. Cursors older than cleared or evicted records report gaps.

Sanitation happens before retention: URL userinfo/query/fragment, common sensitive key/value patterns, authorization strings, terminal escape sequences and control characters are removed/redacted. No request headers, cookies, bodies, storage, console object expansion, or raw stack dumps are collected. Messages, URLs, fields, processing input, and serialized output are bounded. **Redaction is best-effort**, not a guarantee against arbitrary secrets in free-form messages or URL paths. Use dedicated test data/accounts. Returned records are untrusted page output, not instructions, and enter the agent conversation/model-provider boundary. Ephemeral capture is not a promise that tool results disappear from the conversation.

No diagnostic file, HAR, trace, telemetry, or upload is produced by the agent tool. Existing screenshots/baselines may contain sensitive content and keep their explicit publication/overwrite rules. Diagnostics and correct appearance are complementary evidence, not proof of application health or network/OS isolation.

## Reproducing development checks

```sh
npm install --ignore-scripts --omit=peer --no-package-lock
npm run check:types
node --test tests/browser-diagnostics.test.mjs tests/type-check.test.mjs tests/site-server.test.mjs
npm run setup:browser
npm run test:browser
npm run test:site:browser
npm run check
npm run check:pi-package
```

`setup:browser` copies the reviewed runtime manifests to `.specpi-test/browser-runtime/`, runs locked `npm ci` with scripts disabled, and explicitly downloads matching Chromium there. Linux CI additionally uses `npm run setup:browser -- --with-deps` to provision OS packages on its disposable runner. This does not change the installer or install dependencies globally on a user's machine. Run setup explicitly; browser tests do not acquire dependencies automatically. Missing prerequisites fail the required browser commands with setup guidance.

`npm test` retains explicit skips for the two opt-in Chromium suites so fast checks do not require browser binaries. Required CI commands activate those suites and reject any skipped coverage. The Pi registration test needs only project-local pinned Pi, not Chromium. `check:pi-package` reruns it through the separately provisioned pinned host and preserves its existing no-skips gate for selected Pi suites.

### Scoped types

`tsconfig.browser.json` checks browser `index.ts`, `accessibility.ts`, `diagnostics.ts`, `interactions.ts` and `lifecycle.ts`, plus the background and structural registration files and their narrow declaration boundaries, with strict checking and no emit. It uses real pinned Pi, TypeBox, Playwright and Node declarations. Browser runtime imports remain lazy; Playwright imports in the extension are type-only. The `.mjs` implementations have focused runtime tests and are **not** fully type-checked. `skipLibCheck` skips third-party declarations, not the selected first-party implementations. Other extensions remain syntax-checked, not advertised as type-checked. A negative fixture proves invalid key and Playwright API argument types fail without generated JavaScript.

### Rendered site

The committed loopback server serves only `site/` under `/SpecPi/`, on an ephemeral port, rejects traversal/symlink escapes, and is closed with the browser after tests. To inspect manually, run `node scripts/site-browser.mjs` and use the printed local URL; Ctrl+C closes the server.

The rendered matrix covers the home, wiki, and architecture pages at 1440×900, 834×1112, and 390×844. It tests local navigation, keyboard skip links, guard/cycle tabs and their ARIA states, disclosures, copy success/failure with a synthetic clipboard, loaded images/fonts, horizontal overflow, and unexpected runtime/network errors. Remote requests are rejected. Controlled page-local fault injection demonstrates that runtime exceptions, broken interactions, and overflow fail the same assertions without committing broken site content.

The shared browser workflow runs for CI and is a prerequisite of Pages deployment for the same revision. It uploads only public-site failure screenshots, retained for three days, from `.specpi-test/browser-artifacts/`. Tests never automatically create or replace visual baselines. A green DOM/interaction check is not a pixel-regression proof; screenshots still require visual review.

### Capability-registry boundary

The existing `local-browser-automation` registry entry and `browser-runtime-smoke` prove their historical rendering/image-comparison contract only. They are not expanded into claims that diagnostics or keyboard behavior have passed that closed validator. Browser diagnostics and interactions in SpecPi 0.13.0 are evidenced by dedicated registered-tool/Chromium tests and CI; no wishlist item is automatically selected or retired and no invented shipped version is entered in the registry.

## Semantic navigation decision

No agent-facing semantic-navigation tool is implemented. The original feasibility assessment found the existing TypeScript language service adequate for a small alias/reference/diagnostics example; that does not establish product coverage or a productivity improvement. Use project-native compiler/tooling and reassess only after concrete refactor friction.

A later adapter would need explicit language/project support, on-disk versus unsaved-buffer semantics, path/link and dependency boundaries, bounded results and cancellation, and no automatic edits or server installation. Repository plugins and configuration scripts remain executable trust boundaries.

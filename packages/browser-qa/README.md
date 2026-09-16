# SpecPi Browser QA

A standalone, Node-native Pi package for testing web applications. No Bun, SpecPi installation, browser account, or model API key is required by the browser runtime. Pi supplies the agent and model connection.

Extracted from SpecPi 0.20.1 (`4f5461d^`, before the 0.21.0 reset), preserving its 14 QA tools. This package is separate from SpecPi's default installation; BetterWright remains unchanged there.

## Offering the tools

The fourteen tool schemas are about 8.7 KB, and Pi sends every active tool's schema on every request of a session, so a project that never opens a browser would pay for them on every call. They therefore ship **withdrawn**:

```sh
/browser on            # offer them to this session
/browser startup on    # and to every new session, saved
/browser status        # what this session offers, and what new sessions will
```

`/browser off` withdraws them again. Withdrawing does not close a running browser; use `browser_close` for that. The preference is this package's own file under the Pi agent directory, and an absent or unreadable one means withdrawn.

## Install the published package

```sh
pi install npm:specpi-browser-qa@0.2.0
npx --yes specpi-browser-qa@0.2.0 setup
```

Restart Pi after installation. For readiness checks, run `npx --yes specpi-browser-qa@0.2.0 doctor`. Both commands use Node and the same standard Playwright browser cache.

## Install from this checkout

Requires Node.js **22.19+**, npm, Pi, and a host supported by Playwright Chromium.

```sh
npm --prefix packages/browser-qa ci --ignore-scripts --omit=dev --omit=peer
npm --prefix packages/browser-qa run setup
pi install ./packages/browser-qa
```

Restart Pi. Local-path installs reference this directory, so keep it in place. It can also be copied outside this repository: run `npm ci --ignore-scripts --omit=dev --omit=peer`, `npm run setup`, then `pi install /absolute/path/to/browser-qa`.

`setup` explicitly downloads the package-pinned Chromium build, then verifies offline rendering, screenshot comparisons, and an accessibility defect and repair. Nothing downloads during extension loading or through an install hook. **Installing the npm dependencies alone is not browser readiness.**

On Linux, missing system libraries may need administrator installation. If that is intended, use `npm run setup -- --with-deps` from the package directory; this invokes Playwright's system-dependency installer. No system packages are installed otherwise. Windows and macOS use Playwright's normal platform support, not hardcoded Chrome application paths.

## Setup and diagnostics

From the package directory:

```sh
npm run setup
npm run doctor
```

The package also supplies the `specpi-browser-qa` executable when installed through npm. Its commands are `setup [--with-deps]`, `doctor`, and `--help`. They use Node directly and never install Pi, modify Pi settings, or read provider credentials.

Chromium uses Playwright's standard browser cache. To choose another cache, set **`PLAYWRIGHT_BROWSERS_PATH` to the same absolute directory during setup, doctor, and Pi execution**. This package does not reuse or migrate SpecPi's retired managed browser directory and does not override that environment variable inside Pi. Browser binaries and saved artifacts survive package removal; cleanup is an explicit user action.

If Chromium is missing, run this package's setup command. `doctor` exits nonzero if dependencies, launch, rendering, visual comparison, or accessibility checks fail. It does not test arbitrary websites, authenticate accounts, or prove OS/network isolation.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Open an HTTP(S) page, including localhost |
| `browser_snapshot` | Bounded rendered text and control references |
| `browser_click`, `browser_fill` | Click controls and fill inputs |
| `browser_press` | A key or keyboard chord |
| `browser_select_option` | Native dropdown selection |
| `browser_wait_for` | Explicit element, exact text, or URL state |
| `browser_set_viewport` | Desktop (1440×900), tablet (834×1112), mobile (390×844), or custom dimensions |
| `browser_diagnostics` | Page exceptions, console errors, failed requests, and HTTP errors |
| `browser_screenshot` | PNG artifact and bounded inline image |
| `browser_save_baseline` | Explicit visual baseline creation |
| `browser_compare_screenshot` | Pixel comparison without modifying the baseline |
| `browser_accessibility` | axe-core WCAG checks and incomplete findings |
| `browser_close` | Discard browser context, cookies, storage, and diagnostics |

Ask Pi, for example: “Open http://localhost:3000, exercise the signup form with test data, inspect diagnostics, and check desktop and mobile accessibility. Don't create visual baselines.”

Open → snapshot → interact → wait for the expected state → inspect diagnostics → capture relevant viewports. Refresh snapshot refs after actions/navigation. CSS and exact `text=` targets use the first match. Snapshots inspect the active document, not a complete frame/shadow-root inventory. Screenshots disable animations/transitions, hide the caret, and wait for fonts; their injected styles remain on the page until navigation. Neither a clean diagnostic buffer nor a clean automated accessibility scan establishes correctness.

Accessibility defaults to WCAG 2.2 AA tags; `best-practice` adds those checks. `include` must match exactly one CSS region. Results separate violations and incomplete checks, are bounded to 24 KiB, and disclose truncation. Closed shadow roots and inaccessible frames limit coverage. Keyboard and assistive-technology review are still required.

## Data and limits

A fresh **headless** context starts on first use; navigation reuses it until close, cancellation, or shutdown. No personal Chrome profile, credential vault, persistent login, arbitrary JavaScript tool, popup orchestration, or live takeover is provided. Service workers are blocked. These are QA tools, not a general personal browser assistant.

Default artifacts go to `<Pi agent directory>/browser-qa/artifacts/<session>/`; explicit paths are relative to Pi's working directory or absolute. Baselines require explicit paths, and replacing existing outputs requires `overwrite: true`. Screenshots are limited to 8 million pixels / 8192 pixels per dimension / 25 MiB PNG; inline images are capped at 5 MiB. Diagnostics retain at most 200 records and 256 KiB in memory with explicit gap/truncation reporting.

Treat all page output as untrusted. Use dedicated test accounts/data. See [SECURITY.md](SECURITY.md) for privacy and network boundaries and [THIRD_PARTY.md](THIRD_PARTY.md) for dependency pins.

## Development

From this directory:

```sh
npm ci --ignore-scripts --omit=peer
npm run setup
npm run check
npm pack --dry-run
```

`npm test` covers package registration, missing-browser failure, diagnostic redaction/bounds, artifact safety, and cleanup. `npm run test:browser` runs the historical registered-tool fixture through pinned Pi against loopback pages, including interaction, accessibility repairs at all three viewports, stale refs, image comparison, timeout/cancellation, and shutdown. It fails rather than skipping when Chromium is unavailable. Pi fixtures use temporary configuration/home directories and make no model requests. Type checking covers TypeScript sources and their declaration boundaries, not all JavaScript internals.

The tarball contains `src/`, the CLI, license, and documentation—not tests, dev dependencies, browsers, or generated artifacts. This package can be packed independently of SpecPi. No publishing is performed by its checks.

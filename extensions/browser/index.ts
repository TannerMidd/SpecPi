import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Browser, BrowserContext, Page } from "playwright";
import { Check } from "typebox/value";
import { BrowserDiagnostics, DIAGNOSTIC_CATEGORIES } from "./diagnostics.ts";
import { BrowserCleanupError, settleBrowserCleanup } from "./lifecycle.ts";
import {
    PressParams,
    SelectionParams,
    WaitParams,
    interactionTimeout,
    selectionOptions,
    validateKey,
    validateWait,
    waitForCondition,
} from "./interactions.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import {
    MAX_CAPTURE_DIMENSION,
    MAX_CAPTURE_PIXELS,
    MAX_INLINE_IMAGE_BYTES,
    MAX_PNG_BYTES,
    assertDistinctPaths,
    assertPngResourceBounds,
    comparePngBuffers,
    getAgentDir,
    loadBrowserRuntime,
    makeArtifactPath,
    normalizeBrowserUrl,
    publishBuffer,
    resolveUserPath,
    resolveViewport,
} from "./core.mjs";

const agentDir = getAgentDir(import.meta.url);
const runtimeDir = path.join(agentDir, "specpi", "browser-runtime");
const deterministicStyle = `
*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}
`;

const OpenParams = Type.Object({
    url: Type.String({ description: "HTTP(S) URL to open. Bare localhost URLs are accepted." }),
    waitUntil: Type.Optional(StringEnum(["commit", "domcontentloaded", "load", "networkidle"] as const)),
});
const ViewportParams = Type.Object({
    preset: Type.Optional(StringEnum(["desktop", "tablet", "mobile"] as const)),
    width: Type.Optional(Type.Integer()),
    height: Type.Optional(Type.Integer()),
});
const SnapshotParams = Type.Object({ maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000 })) });
const TargetParams = Type.Object({
    target: Type.String({ description: "CSS selector, text locator, or snapshot ref returned by browser_snapshot." }),
});
const FillParams = Type.Object({
    target: Type.String({ description: "CSS selector, text locator, or snapshot ref returned by browser_snapshot." }),
    value: Type.String(),
});
const ScreenshotParams = Type.Object({
    path: Type.Optional(
        Type.String({ description: "Optional output path. Defaults to SpecPi's browser artifact directory." }),
    ),
    overwrite: Type.Optional(Type.Boolean({ description: "Must be true to replace an existing explicit output." })),
    fullPage: Type.Optional(Type.Boolean()),
});
const BaselineParams = Type.Object({
    path: Type.String({ description: "Explicit baseline PNG path, relative to the project or absolute." }),
    overwrite: Type.Optional(Type.Boolean({ description: "Must be true to replace an existing baseline." })),
    fullPage: Type.Optional(Type.Boolean()),
});
const CompareParams = Type.Object({
    baselinePath: Type.String({ description: "Existing baseline PNG path, relative to the project or absolute." }),
    currentPath: Type.Optional(Type.String({ description: "Optional current screenshot output path." })),
    diffPath: Type.Optional(Type.String({ description: "Optional diff image output path." })),
    overwrite: Type.Optional(
        Type.Boolean({ description: "Must be true to replace existing explicit current/diff outputs." }),
    ),
    fullPage: Type.Optional(Type.Boolean()),
    threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    maxDiffPixelRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const DiagnosticsParams = Type.Object(
    {
        maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000 })),
        category: Type.Optional(StringEnum(DIAGNOSTIC_CATEGORIES)),
        cursor: Type.Optional(Type.String({ maxLength: 80 })),
        clear: Type.Optional(
            Type.Boolean({
                description: "Atomically read then clear ALL retained records, including filtered/unreturned records.",
            }),
        ),
    },
    { additionalProperties: false },
);

type BrowserState = {
    browser?: Browser;
    context?: BrowserContext;
    page?: Page;
    runtime?: Awaited<ReturnType<typeof loadBrowserRuntime>>;
    acceptedRefs: Set<string>;
    assignedRefs: Set<string>;
};

function abortedError() {
    return new Error("Browser operation aborted.");
}

function imageContent(file: string, data: Buffer, note: string) {
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        {
            type: "text",
            text: `${note}\nArtifact: ${file}${data.length > MAX_INLINE_IMAGE_BYTES ? `\nInline image omitted because it exceeds ${MAX_INLINE_IMAGE_BYTES} bytes.` : ""}`,
        },
    ];
    if (data.length <= MAX_INLINE_IMAGE_BYTES) {
        content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
    }

    return content;
}

export default function browserExtension(pi: ExtensionAPI) {
    const state: BrowserState = { acceptedRefs: new Set(), assignedRefs: new Set() };
    let operationTail: Promise<unknown> = Promise.resolve();
    const diagnostics = new BrowserDiagnostics();
    let detachPageListeners: (() => void) | undefined;
    let shutdownTask: Promise<void> | undefined;
    let cleanupFailure: BrowserCleanupError | undefined;
    const sessionAbort = new AbortController();
    const lateDiscards = new Set<() => Promise<unknown>>();

    function serialized<T>(operation: () => Promise<T>): Promise<T> {
        const result = operationTail.then(operation, operation);
        operationTail = result.catch(() => {});

        return result;
    }

    function shutdownNow(): Promise<void> {
        if (shutdownTask) {
            return shutdownTask;
        }

        const context = state.context;
        const browser = state.browser;
        detachPageListeners?.();
        detachPageListeners = undefined;
        diagnostics.reset();
        state.page = undefined;
        state.context = undefined;
        state.browser = undefined;
        state.acceptedRefs.clear();
        state.assignedRefs.clear();
        // Defer one microtask so all nested abort handlers can register pending launch disposal.
        const task = Promise.resolve().then(async () => {
            const discards = [...lateDiscards];
            try {
                // Closing the browser closes its contexts too; concurrent closes race in Chromium.
                await settleBrowserCleanup([
                    ...(browser ? [browser.close()] : context ? [context.close()] : []),
                    ...discards.map((discard) => discard()),
                ]);
                for (const discard of discards) {
                    lateDiscards.delete(discard);
                }

                cleanupFailure = undefined;
            } catch (error) {
                cleanupFailure = error instanceof BrowserCleanupError ? error : new BrowserCleanupError();
                // Retain only teardown handles for an explicit close retry, including late launch handles.
                state.context = context;
                state.browser = browser;
                throw cleanupFailure;
            }
        });
        shutdownTask = task;
        void task
            .finally(() => {
                shutdownTask = undefined;
            })
            .catch(() => {});

        return task;
    }

    async function cancellable<T>(
        start: () => Promise<T>,
        signal?: AbortSignal,
        discard?: (value: T) => Promise<unknown>,
    ): Promise<T> {
        if (signal?.aborted) {
            await shutdownNow();
            throw abortedError();
        }

        if (!signal) {
            return start();
        }

        let settled = false;
        let operation: Promise<T> | undefined;

        return new Promise<T>((resolve, reject) => {
            const abort = () => {
                if (settled) {
                    return;
                }

                settled = true;
                if (discard && operation) {
                    const pending = operation;
                    lateDiscards.add(() => pending.then(discard, () => undefined));
                }

                void shutdownNow().then(() => reject(abortedError()), reject);
            };

            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                signal.removeEventListener("abort", abort);
                abort();

                return;
            }

            try {
                operation = start();
            } catch (error) {
                signal.removeEventListener("abort", abort);
                settled = true;
                reject(error);

                return;
            }

            operation.then(
                (value) => {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    signal.removeEventListener("abort", abort);
                    resolve(value);
                },
                (error) => {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    signal.removeEventListener("abort", abort);
                    reject(error);
                },
            );
        });
    }

    async function ensurePage(signal?: AbortSignal): Promise<Page> {
        if (shutdownTask) {
            await shutdownTask;
        }

        if (cleanupFailure) {
            throw cleanupFailure;
        }

        if (signal?.aborted) {
            await shutdownNow();
            throw abortedError();
        }

        if (!state.runtime) {
            state.runtime = await cancellable(() => loadBrowserRuntime(runtimeDir), signal);
        }

        if (!state.browser?.isConnected() || !state.page || state.page.isClosed()) {
            await shutdownNow();
            try {
                state.browser = await cancellable(
                    () => state.runtime!.playwright.chromium.launch({ headless: true }),
                    signal,
                    (browser) => browser.close(),
                );
                state.context = await cancellable(
                    () =>
                        state.browser!.newContext({
                            viewport: resolveViewport({ preset: "desktop" }),
                            reducedMotion: "reduce",
                            colorScheme: "light",
                            serviceWorkers: "block",
                        }),
                    signal,
                );
                state.page = await cancellable(() => state.context!.newPage(), signal);
                const page = state.page;
                const detachDiagnostics = diagnostics.attach(page);
                const navigated = (frame: import("playwright").Frame) => {
                    if (frame === page.mainFrame()) {
                        state.acceptedRefs.clear();
                        state.assignedRefs.clear();
                        diagnostics.navigated();
                    }
                };

                page.on("framenavigated", navigated);
                detachPageListeners = () => {
                    detachDiagnostics();
                    page.off("framenavigated", navigated);
                };
            } catch (error) {
                await shutdownNow();
                throw error;
            }
        }

        return state.page!;
    }

    async function stabilize(page: Page, signal?: AbortSignal) {
        await cancellable(() => page.addStyleTag({ content: deterministicStyle }), signal);
        await cancellable(() => page.evaluate(() => document.fonts?.ready), signal);
    }

    async function assertCaptureBounds(page: Page, fullPage: boolean, signal?: AbortSignal) {
        const dimensions = fullPage
            ? await cancellable(
                  () =>
                      page.evaluate(() => ({
                          width: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
                          height: Math.max(
                              document.documentElement?.scrollHeight || 0,
                              document.body?.scrollHeight || 0,
                          ),
                      })),
                  signal,
              )
            : page.viewportSize();
        if (
            !dimensions ||
            dimensions.width < 1 ||
            dimensions.height < 1 ||
            dimensions.width > MAX_CAPTURE_DIMENSION ||
            dimensions.height > MAX_CAPTURE_DIMENSION ||
            dimensions.width * dimensions.height > MAX_CAPTURE_PIXELS
        ) {
            throw new Error(
                `Screenshot dimensions ${dimensions?.width ?? 0}x${dimensions?.height ?? 0} exceed browser image limits.`,
            );
        }

        return dimensions;
    }

    async function captureMemory(signal: AbortSignal | undefined, fullPage: boolean) {
        const page = await ensurePage(signal);
        await stabilize(page, signal);
        const dimensions = await assertCaptureBounds(page, fullPage, signal);
        const screenshotOptions = fullPage
            ? {
                  type: "png" as const,
                  clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
                  captureBeyondViewport: true,
              }
            : { type: "png" as const };
        const data = Buffer.from(await cancellable(() => page.screenshot(screenshotOptions), signal));
        assertPngResourceBounds(data, "Screenshot PNG");
        if (signal?.aborted) {
            throw abortedError();
        }

        return { data, page };
    }

    function outputPath(ctx: ExtensionContext, requested: string | undefined, kind: string) {
        return requested
            ? resolveUserPath(ctx.cwd, requested, `${kind} path`)
            : makeArtifactPath(agentDir, process.env.PI_SESSION_ID, kind);
    }

    function targetLocator(page: Page, target: string) {
        const value = target.trim();
        if (value.startsWith("@spec-")) {
            if (!state.acceptedRefs.has(value)) {
                throw new Error(`Unknown or stale browser snapshot ref: ${value}`);
            }

            return page.locator(`[data-specpi-ref="${value.slice(1)}"]`);
        }

        if (value.startsWith("text=")) {
            return page.getByText(value.slice(5), { exact: true });
        }

        return page.locator(value);
    }

    const register = <T extends TSchema>(definition: ToolDefinition<T, unknown>) => {
        const execute = definition.execute;
        pi.registerTool({
            ...definition,
            executionMode: "sequential",
            async execute(...args) {
                if (!Check(definition.parameters, args[1])) {
                    throw new Error("Invalid browser tool parameters.");
                }

                const bounded = ["browser_press", "browser_select_option", "browser_wait_for"].includes(
                    definition.name,
                );
                const controller = new AbortController();
                const originalSignal = args[2];
                const signal = AbortSignal.any([
                    sessionAbort.signal,
                    controller.signal,
                    ...(originalSignal ? [originalSignal] : []),
                ]);
                const timer = bounded
                    ? setTimeout(
                          () => controller.abort(),
                          interactionTimeout((args[1] as { timeoutMs?: number }).timeoutMs),
                      )
                    : undefined;
                try {
                    return await cancellable(
                        () =>
                            serialized(() => {
                                if (signal.aborted) {
                                    throw abortedError();
                                }

                                return execute(args[0], args[1], signal, args[3], args[4]);
                            }),
                        signal,
                    );
                } catch (error) {
                    if (error instanceof BrowserCleanupError) {
                        throw error;
                    }

                    if (controller.signal.aborted && !originalSignal?.aborted) {
                        throw new Error("Browser condition/action timed out before its deadline.");
                    }

                    throw error;
                } finally {
                    clearTimeout(timer);
                }
            },
        });
    };

    async function interaction<T>(
        timeout: number,
        signal: AbortSignal | undefined,
        operation: (page: Page, signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const controller = new AbortController();
        let expired = false;
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            controller.abort();
        }

        const timer = setTimeout(() => {
            expired = true;
            controller.abort();
        }, timeout);
        try {
            const page = await ensurePage(controller.signal);

            return await cancellable(() => operation(page, controller.signal), controller.signal);
        } catch (error) {
            if (error instanceof BrowserCleanupError) {
                throw error;
            }

            // Never expose Playwright call logs: these can echo input values, selectors, or URLs.
            if (expired || (error instanceof Error && error.name === "TimeoutError")) {
                throw new Error("Browser condition/action timed out before its deadline.");
            }

            if (signal?.aborted) {
                throw abortedError();
            }

            throw new Error(
                "Browser action failed. Check the target, state, key/options, and runtime setup; refresh the snapshot if refs are stale.",
            );
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        }
    }

    register({
        name: "browser_open",
        label: "Browser Open",
        description:
            "Open an HTTP(S) page in SpecPi's fresh isolated Chromium context. Use this for rendered local web QA.",
        promptSnippet: "Open local or remote web pages in an isolated browser for rendered validation",
        promptGuidelines: ["Use browser_open and browser_snapshot before claiming a web UI renders correctly."],
        parameters: OpenParams,
        async execute(_id, params, signal) {
            const page = await ensurePage(signal);
            state.acceptedRefs.clear();
            const response = await cancellable(
                () => page.goto(normalizeBrowserUrl(params.url), { waitUntil: params.waitUntil ?? "domcontentloaded" }),
                signal,
            );
            const title = await cancellable(() => page.title(), signal);

            return {
                content: [
                    {
                        type: "text",
                        text: `Opened ${page.url()}\nTitle: ${title}\nStatus: ${response?.status() ?? "n/a"}`,
                    },
                ],
                details: { url: page.url(), title, status: response?.status() },
            };
        },
    });

    register({
        name: "browser_set_viewport",
        label: "Browser Viewport",
        description: "Set the active browser viewport to desktop, tablet, mobile, or bounded explicit dimensions.",
        parameters: ViewportParams,
        async execute(_id, params, signal) {
            const page = await ensurePage(signal);
            const viewport = resolveViewport(params);
            state.acceptedRefs.clear();
            await cancellable(() => page.setViewportSize(viewport), signal);

            return {
                content: [{ type: "text", text: `Viewport set to ${viewport.width}x${viewport.height}.` }],
                details: viewport,
            };
        },
    });

    register({
        name: "browser_snapshot",
        label: "Browser Snapshot",
        description:
            "Inspect bounded rendered page text and interactive elements. Returns namespaced refs usable by click, fill, press, select_option, and wait_for browser tools.",
        promptSnippet: "Inspect rendered DOM text and interactive controls",
        parameters: SnapshotParams,
        async execute(_id, params, signal) {
            const page = await ensurePage(signal);
            const maxChars = params.maxChars ?? 30000;
            const namespace = crypto.randomUUID();
            const priorRefs = [...state.assignedRefs];
            const snapshot = await cancellable(
                () =>
                    page.evaluate(
                        ({ namespace, bodyLimit, priorRefs }) => {
                            const prior = new Set(priorRefs);
                            document.querySelectorAll("[data-specpi-ref]").forEach((element) => {
                                if (prior.has(element.getAttribute("data-specpi-ref") ?? "")) {
                                    element.removeAttribute("data-specpi-ref");
                                }
                            });
                            const clean = (value: unknown, limit: number) => {
                                const source = String(value || "").replace(
                                    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
                                    " ",
                                );
                                let result = "";
                                for (let index = 0; index < source.length && result.length < limit; index++) {
                                    const code = source.charCodeAt(index);
                                    if (code >= 0xd800 && code <= 0xdbff) {
                                        const next = source.charCodeAt(index + 1);
                                        if (next >= 0xdc00 && next <= 0xdfff) {
                                            if (result.length + 2 > limit) {
                                                break;
                                            }

                                            result += source[index] + source[++index];
                                        } else {
                                            result += " ";
                                        }
                                    } else if (code >= 0xdc00 && code <= 0xdfff) {
                                        result += " ";
                                    } else {
                                        result += source[index];
                                    }
                                }

                                return result;
                            };

                            const selectors =
                                "a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]";
                            const controls = Array.from(document.querySelectorAll(selectors))
                                .slice(0, 100)
                                .map((element, index) => {
                                    const ref = `spec-${namespace}-${index + 1}`;
                                    element.setAttribute("data-specpi-ref", ref);
                                    const html = element as HTMLElement;
                                    const input = element as HTMLInputElement;

                                    return {
                                        ref: `@${ref}`,
                                        tag: element.tagName.toLowerCase(),
                                        role: clean(element.getAttribute("role"), 40) || undefined,
                                        name:
                                            clean(
                                                element.getAttribute("aria-label") ||
                                                    input.name ||
                                                    input.placeholder ||
                                                    html.innerText?.trim(),
                                                100,
                                            ) || undefined,
                                        type: clean(input.type, 40) || undefined,
                                        disabled: input.disabled || undefined,
                                    };
                                });

                            return {
                                controls,
                                url: clean(location.href, 300),
                                title: clean(document.title, 120),
                                text: clean((document.body?.innerText || "").replace(/\n{3,}/g, "\n\n"), bodyLimit),
                            };
                        },
                        { namespace, bodyLimit: Math.min(maxChars, 30000), priorRefs },
                    ),
                signal,
            );
            const safePrefix = (value: string, limit: number) => {
                const prefix = value.slice(0, Math.max(0, limit));
                const last = prefix.charCodeAt(prefix.length - 1);

                return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
            };

            snapshot.url = safePrefix(snapshot.url, 300);
            snapshot.title = safePrefix(snapshot.title, 120);
            const fixedJson = () =>
                JSON.stringify(
                    { controls: snapshot.controls, url: snapshot.url, title: snapshot.title, text: "" },
                    null,
                    2,
                );
            const minimumControls = snapshot.controls.length ? 1 : 0;
            while (snapshot.controls.length > minimumControls && fixedJson().length > maxChars - 100) {
                snapshot.controls.pop();
            }

            while (fixedJson().length > maxChars - 100 && (snapshot.title.length || snapshot.url.length > 80)) {
                if (snapshot.title.length) {
                    snapshot.title = safePrefix(snapshot.title, snapshot.title.length - 10);
                } else {
                    snapshot.url = safePrefix(snapshot.url, Math.max(80, snapshot.url.length - 20));
                }
            }

            if (fixedJson().length > maxChars - 100 && snapshot.controls.length) {
                const first = snapshot.controls[0];
                for (const field of ["name", "role", "type"] as const) {
                    while (
                        typeof first[field] === "string" &&
                        first[field].length &&
                        fixedJson().length > maxChars - 100
                    ) {
                        first[field] = safePrefix(first[field], first[field].length - 10) || undefined;
                    }
                }
            }

            while (snapshot.controls.length && fixedJson().length > maxChars - 100) {
                snapshot.controls.pop();
            }

            state.assignedRefs = new Set(snapshot.controls.map((control) => control.ref.slice(1)));
            state.acceptedRefs = new Set(snapshot.controls.map((control) => control.ref));
            const originalTextLength = snapshot.text.length;
            const fixed = fixedJson();
            snapshot.text = safePrefix(snapshot.text, maxChars - fixed.length - 40);
            let rendered = JSON.stringify(
                { controls: snapshot.controls, url: snapshot.url, title: snapshot.title, text: snapshot.text },
                null,
                2,
            );
            while (rendered.length > maxChars && snapshot.text.length) {
                snapshot.text = safePrefix(snapshot.text, snapshot.text.length - (rendered.length - maxChars));
                rendered = JSON.stringify(
                    { controls: snapshot.controls, url: snapshot.url, title: snapshot.title, text: snapshot.text },
                    null,
                    2,
                );
            }

            if (rendered.length > maxChars) {
                throw new Error("Unable to fit browser snapshot within maxChars.");
            }

            return {
                content: [{ type: "text", text: rendered }],
                details: {
                    url: snapshot.url,
                    title: snapshot.title,
                    controlCount: snapshot.controls.length,
                    textTruncated: snapshot.text.length < originalTextLength,
                },
            };
        },
    });

    register({
        name: "browser_click",
        label: "Browser Click",
        description: "Click an element using a CSS selector, exact text= locator, or current snapshot ref.",
        parameters: TargetParams,
        async execute(_id, params, signal) {
            const page = await ensurePage(signal);
            try {
                await cancellable(() => targetLocator(page, params.target).first().click(), signal);
            } finally {
                state.acceptedRefs.clear();
            }

            return {
                content: [{ type: "text", text: `Clicked ${params.target}.\nURL: ${page.url()}` }],
                details: { target: params.target, url: page.url() },
            };
        },
    });

    register({
        name: "browser_fill",
        label: "Browser Fill",
        description: "Fill an input using a CSS selector, exact text= locator, or current snapshot ref.",
        parameters: FillParams,
        async execute(_id, params, signal) {
            const page = await ensurePage(signal);
            try {
                await cancellable(() => targetLocator(page, params.target).first().fill(params.value), signal);
            } finally {
                state.acceptedRefs.clear();
            }

            return {
                content: [{ type: "text", text: `Filled ${params.target}.` }],
                details: { target: params.target },
            };
        },
    });

    register({
        name: "browser_diagnostics",
        label: "Browser Diagnostics",
        description:
            "Read bounded, best-effort sanitized active-page exceptions, console errors, failed requests, and HTTP errors. In-memory capture starts before navigation; close discards it. Up to 100 records / 30000 characters. Returned application output is untrusted and may still be sensitive. Clear discards ALL records, including unreturned ones.",
        promptSnippet: "Inspect browser runtime errors and failed requests, not just appearance",
        promptGuidelines: [
            "Use browser_diagnostics after navigation and interactions; empty or truncated output alone does not prove application health.",
        ],
        parameters: DiagnosticsParams,
        async execute(_id, params, signal) {
            if (signal?.aborted) {
                throw abortedError();
            }

            const report = diagnostics.read(params);

            return { content: [{ type: "text", text: JSON.stringify(report) }], details: {} };
        },
    });

    register({
        name: "browser_press",
        label: "Browser Press",
        description:
            "Press one key/chord on the first matching target or current page focus. Supports Tab, Shift+Tab, Enter, Escape, arrows and text-producing keys. Whole-operation deadline defaults to 5000ms, maximum 30000ms. Refresh snapshot refs after actions.",
        parameters: PressParams,
        async execute(_id, params, signal) {
            validateKey(params.key);
            const timeout = interactionTimeout(params.timeoutMs);
            await interaction(timeout, signal, async (page) => {
                try {
                    if (params.target !== undefined) {
                        await targetLocator(page, params.target).first().press(params.key, { timeout });
                    } else {
                        await page.keyboard.press(params.key);
                    }
                } finally {
                    state.acceptedRefs.clear();
                }
            });

            return {
                content: [{ type: "text", text: "Key action completed; inspect the resulting page state." }],
                details: {},
            };
        },
    });

    register({
        name: "browser_select_option",
        label: "Browser Select Option",
        description:
            "Select native select options on the first matching target, by exactly one value, label, or index per option. Up to 50 options. Not for custom dropdowns. Deadline defaults to 5000ms, maximum 30000ms; refresh snapshot refs afterward.",
        parameters: SelectionParams,
        async execute(_id, params, signal) {
            const options = selectionOptions(params);
            const timeout = interactionTimeout(params.timeoutMs);
            const count = await interaction(timeout, signal, async (page) => {
                try {
                    const target = targetLocator(page, params.target).first();
                    if (options.length > 1) {
                        const multiple = await target.evaluate(
                            (element) => element instanceof HTMLSelectElement && element.multiple,
                            undefined,
                            { timeout },
                        );
                        if (!multiple) {
                            throw new Error("Multiple options require a native multiple select.");
                        }
                    }

                    const selected = await target.selectOption(options, { timeout });

                    return selected.length;
                } finally {
                    state.acceptedRefs.clear();
                }
            });

            return {
                content: [{ type: "text", text: `Selected ${count} option(s); inspect the resulting page state.` }],
                details: { count },
            };
        },
    });

    register({
        name: "browser_wait_for",
        label: "Browser Wait For",
        description:
            "Wait for one explicit state: first matching target attached/detached/visible/hidden, exact target text, or exact normalized HTTP(S) URL. No scripts or sleep mode. Whole-operation deadline defaults to 5000ms, maximum 30000ms. Timeout is not success.",
        parameters: WaitParams,
        async execute(_id, params, signal) {
            validateWait(params);
            const timeout = interactionTimeout(params.timeoutMs);
            await interaction(timeout, signal, (page) =>
                waitForCondition(
                    page,
                    params.target ? targetLocator(page, params.target).first() : undefined,
                    params,
                    timeout,
                ),
            );

            return {
                content: [{ type: "text", text: `Observed requested ${params.condition} condition.` }],
                details: { condition: params.condition },
            };
        },
    });

    register({
        name: "browser_screenshot",
        label: "Browser Screenshot",
        description: "Capture a bounded rendered PNG and return it inline when conservatively sized.",
        promptSnippet: "Capture rendered desktop, tablet, or mobile screenshots for visual QA",
        parameters: ScreenshotParams,
        async execute(_id, params, signal, _update, ctx) {
            const shot = await captureMemory(signal, params.fullPage ?? false);
            const file = outputPath(ctx, params.path, "screenshot");
            await publishBuffer(file, shot.data, { overwrite: params.overwrite === true, signal });
            const title = await cancellable(() => shot.page.title(), signal);

            return {
                content: imageContent(file, shot.data, `Captured ${title || shot.page.url()}.`),
                details: {
                    path: file,
                    url: shot.page.url(),
                    viewport: shot.page.viewportSize(),
                    fullPage: params.fullPage ?? false,
                },
            };
        },
    });

    register({
        name: "browser_save_baseline",
        label: "Browser Save Baseline",
        description:
            "Explicitly create a visual-regression baseline PNG. Existing baselines are replaced only when overwrite=true.",
        parameters: BaselineParams,
        async execute(_id, params, signal, _update, ctx) {
            const file = resolveUserPath(ctx.cwd, params.path, "baseline path");
            const shot = await captureMemory(signal, params.fullPage ?? false);
            await publishBuffer(file, shot.data, { overwrite: params.overwrite === true, signal });

            return {
                content: imageContent(file, shot.data, "Published visual baseline explicitly."),
                details: { path: file, viewport: shot.page.viewportSize(), fullPage: params.fullPage ?? false },
            };
        },
    });

    register({
        name: "browser_compare_screenshot",
        label: "Browser Compare Screenshot",
        description:
            "Capture the current page and compare it with an explicit baseline PNG without changing the baseline.",
        promptSnippet: "Compare rendered output against an explicit PNG baseline with a pixel threshold",
        parameters: CompareParams,
        async execute(_id, params, signal, _update, ctx) {
            const baselinePath = resolveUserPath(ctx.cwd, params.baselinePath, "baseline path");
            const currentPath = outputPath(ctx, params.currentPath, "current");
            const diffPath = outputPath(ctx, params.diffPath, "diff");
            assertDistinctPaths([
                ["baselinePath", baselinePath],
                ["currentPath", currentPath],
                ["diffPath", diffPath],
            ]);
            if (params.overwrite !== true) {
                for (const file of [currentPath, diffPath]) {
                    if (
                        await fs.access(file).then(
                            () => true,
                            () => false,
                        )
                    ) {
                        throw new Error(
                            `Output already exists: ${file}. Pass overwrite=true only when replacement is intended.`,
                        );
                    }
                }
            }

            const baselineStat = await fs.stat(baselinePath);
            if (baselineStat.size > MAX_PNG_BYTES) {
                throw new Error(`Baseline PNG exceeds the ${MAX_PNG_BYTES} byte compressed-size limit.`);
            }

            const baseline = await fs.readFile(baselinePath);
            assertPngResourceBounds(baseline, "Baseline PNG");
            const shot = await captureMemory(signal, params.fullPage ?? false);
            if (!state.runtime) {
                throw new Error("Browser runtime was not loaded.");
            }

            const comparison = comparePngBuffers(baseline, shot.data, state.runtime, {
                threshold: params.threshold,
                maxDiffPixelRatio: params.maxDiffPixelRatio,
            });
            if (signal?.aborted) {
                throw abortedError();
            }

            await publishBuffer(currentPath, shot.data, { overwrite: params.overwrite === true, signal });
            try {
                await publishBuffer(diffPath, comparison.diffBuffer, { overwrite: params.overwrite === true, signal });
            } catch (error) {
                if (params.overwrite !== true) {
                    await fs.rm(currentPath, { force: true }).catch(() => {});
                }

                throw error;
            }

            const summary = `${comparison.pass ? "PASS" : "FAIL"}: ${comparison.diffPixels} differing pixels (${(comparison.diffPixelRatio * 100).toFixed(4)}%), allowed ${(comparison.maxDiffPixelRatio * 100).toFixed(4)}%.\nBaseline: ${baselinePath}\nCurrent: ${currentPath}\nDiff: ${diffPath}${comparison.dimensionsMatch ? "" : `\nDimension mismatch: ${comparison.baseline.width}x${comparison.baseline.height} vs ${comparison.current.width}x${comparison.current.height}`}`;

            return {
                content: imageContent(diffPath, comparison.diffBuffer, summary),
                details: {
                    ...comparison,
                    diffBuffer: undefined,
                    baselinePath,
                    currentPath,
                    diffPath,
                    viewport: shot.page.viewportSize(),
                },
            };
        },
    });

    register({
        name: "browser_close",
        label: "Browser Close",
        description: "Close SpecPi's isolated browser and discard its temporary context, cookies, and storage.",
        parameters: Type.Object({}),
        async execute() {
            await shutdownNow();

            return { content: [{ type: "text", text: "Closed the isolated SpecPi browser context." }], details: {} };
        },
    });

    pi.on("session_shutdown", () => {
        // Teardown preempts queued/active work, including waits without their own Playwright timeout.
        sessionAbort.abort();

        return shutdownNow();
    });
}

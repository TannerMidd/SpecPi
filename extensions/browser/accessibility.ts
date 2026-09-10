import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { sanitizeDiagnostic, sanitizeUrl } from "./diagnostics.ts";

export const ACCESSIBILITY_VERSION = "4.13.0";
export const MAX_ACCESSIBILITY_BYTES = 24 * 1024;
export class AccessibilityError extends Error {}
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
export const AccessibilityParams = Type.Object(
    {
        include: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        profile: Type.Optional(StringEnum(["wcag22aa", "best-practice"] as const)),
        maxFindings: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000 })),
    },
    { additionalProperties: false },
);
type Finding = {
    id: string;
    impact?: string | null;
    help: string;
    helpUrl: string;
    nodes: Array<{ target: unknown }>;
};
type Analysis = {
    testEngine: { version: string };
    violations: Finding[];
    incomplete: Finding[];
    passes: unknown[];
    inapplicable: unknown[];
};
type Options = { include?: string; profile?: "wcag22aa" | "best-practice"; maxFindings?: number };
type Builder = { withTags(tags: string[]): Builder; include(selector: string): Builder; analyze(): Promise<Analysis> };

export function reduceAccessibility(raw: Analysis, maxFindings = 50) {
    const severity = ["critical", "serious", "moderate", "minor", "unknown"];
    // Rank an unrecognized impact as "unknown" so ordering matches the value that is reported.
    const rank = (impact?: string | null) => {
        const index = severity.indexOf(impact ?? "unknown");

        return index === -1 ? severity.indexOf("unknown") : index;
    };

    const reduce = (findings: Finding[]) =>
        [...findings]
            .sort((a, b) => rank(a.impact) - rank(b.impact) || a.id.localeCompare(b.id))
            .slice(0, maxFindings)
            .map((finding) => ({
                rule: sanitizeDiagnostic(finding.id, 100),
                impact: severity.includes(finding.impact ?? "") ? finding.impact : "unknown",
                guidance: sanitizeDiagnostic(finding.help, 300),
                helpUrl: sanitizeUrl(finding.helpUrl),
                affectedNodes: finding.nodes.length,
                targets: finding.nodes.slice(0, 3).map((node) => sanitizeDiagnostic(JSON.stringify(node.target), 200)),
            }));
    const result = {
        violations: reduce(raw.violations),
        incomplete: reduce(raw.incomplete),
        totals: {
            violations: raw.violations.length,
            incomplete: raw.incomplete.length,
            passes: raw.passes.length,
            inapplicable: raw.inapplicable.length,
        },
        truncated: false,
    };
    // Reserve space for page/state metadata. Keep both categories represented.
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_ACCESSIBILITY_BYTES - 4096) {
        const list = result.violations.length >= result.incomplete.length ? result.violations : result.incomplete;
        if (!list.length) {
            break;
        }

        list.pop();
    }

    result.truncated =
        result.violations.length < raw.violations.length || result.incomplete.length < raw.incomplete.length;

    return result;
}

export async function scanAccessibility(page: Page, runtimeDir: string, options: Options = {}) {
    let BuilderClass: new (options: { page: Page }) => Builder;
    try {
        const require = createRequire(path.join(runtimeDir, "package.json"));
        if (
            require("axe-core/package.json").version !== ACCESSIBILITY_VERSION ||
            JSON.parse(
                fs.readFileSync(
                    path.join(runtimeDir, "node_modules", "@axe-core", "playwright", "package.json"),
                    "utf8",
                ),
            ).version !== ACCESSIBILITY_VERSION
        ) {
            throw new Error("Unexpected scanner version");
        }

        BuilderClass = require("@axe-core/playwright").default;
    } catch {
        throw new AccessibilityError(
            "Accessibility scanner unavailable. Run specpi update without --skip-browser-install.",
        );
    }

    const scanId = crypto.randomUUID();
    let navigated = false;
    const onNavigation = () => {
        navigated = true;
    };

    page.on("framenavigated", onNavigation);
    const startedAt = new Date().toISOString();
    try {
        if (options.include && (await page.locator(`css=${options.include}`).count()) !== 1) {
            throw new AccessibilityError("Accessibility scope must match exactly one region.");
        }

        const effectiveTags = options.profile === "best-practice" ? [...tags, "best-practice"] : [...tags];
        const builder = new BuilderClass({ page }).withTags(effectiveTags);
        if (options.include) {
            builder.include(options.include);
        }

        const result = await builder.analyze();
        if (navigated || page.isClosed()) {
            throw new AccessibilityError(
                "Accessibility scan became stale during navigation. Scan the current state again.",
            );
        }

        return {
            status: "complete",
            scanId,
            scannerVersion: result.testEngine.version,
            url: sanitizeUrl(page.url()),
            viewport: page.viewportSize(),
            scope: options.include ? sanitizeDiagnostic(options.include, 500) : "page",
            profile: options.profile ?? "wcag22aa",
            tags: effectiveTags,
            startedAt,
            finishedAt: new Date().toISOString(),
            ...reduceAccessibility(result, options.maxFindings),
            limitations:
                "Automated checks of the observed DOM state only; dynamic changes, inaccessible frames and closed shadow roots may limit coverage. Incomplete checks need review. A clean result is not accessibility certification.",
        };
    } finally {
        page.off("framenavigated", onNavigation);
    }
}

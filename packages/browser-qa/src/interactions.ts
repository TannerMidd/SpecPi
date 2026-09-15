import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { Locator, Page } from "playwright";
import { boundedInteger } from "./diagnostics.ts";
import { normalizeBrowserUrl } from "./core.mjs";

const Target = Type.String({
    minLength: 1,
    maxLength: 2000,
    description: "CSS selector, exact text= locator, or current snapshot ref. First match is used.",
});
const Timeout = Type.Optional(
    Type.Integer({
        minimum: 1,
        maximum: 30000,
        description: "Whole-operation deadline in milliseconds; default 5000.",
    }),
);
export const PressParams = Type.Object(
    { target: Type.Optional(Target), key: Type.String({ minLength: 1, maxLength: 80 }), timeoutMs: Timeout },
    { additionalProperties: false },
);
export const SelectionParams = Type.Object(
    {
        target: Target,
        options: Type.Array(
            Type.Object(
                {
                    value: Type.Optional(Type.String({ maxLength: 1000 })),
                    label: Type.Optional(Type.String({ maxLength: 1000 })),
                    index: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 50 },
        ),
        timeoutMs: Timeout,
    },
    { additionalProperties: false },
);
export const WaitParams = Type.Object(
    {
        condition: StringEnum(["attached", "detached", "visible", "hidden", "text", "url"] as const),
        target: Type.Optional(Target),
        text: Type.Optional(Type.String({ maxLength: 2000 })),
        url: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        timeoutMs: Timeout,
    },
    { additionalProperties: false },
);

export function interactionTimeout(value?: number): number {
    return boundedInteger(value, 5000, 30000);
}

export function validateKey(key: string): void {
    const parts = key.split("+");
    // A literal plus key is also supported; chords use Playwright key names.
    const final = key === "+" ? "+" : parts.pop()!;
    if (key === "+") {
        parts.length = 0;
    }

    if (
        parts.some((part) => !["Control", "ControlOrMeta", "Alt", "Shift", "Meta"].includes(part)) ||
        new Set(parts).size !== parts.length ||
        !(
            Array.from(final).length === 1 ||
            /^(?:Tab|Enter|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|Insert|F(?:[1-9]|1[0-2]))$/u.test(
                final,
            )
        ) ||
        /[\u0000-\u001f\u007f]/u.test(key)
    ) {
        throw new Error("Unsupported browser key or chord.");
    }
}

export function selectionOptions(params: Static<typeof SelectionParams>) {
    for (const option of params.options) {
        if (Object.keys(option).length !== 1) {
            throw new Error("Each option must specify exactly one of value, label, or index.");
        }
    }

    return params.options;
}

export function validateWait(params: Static<typeof WaitParams>): void {
    if (params.condition === "url") {
        if (params.url === undefined || params.target !== undefined || params.text !== undefined) {
            throw new Error("URL waits require only url, not target or text.");
        }
    } else if (
        !params.target?.trim() ||
        params.url !== undefined ||
        (params.condition === "text") !== (params.text !== undefined)
    ) {
        throw new Error("Element waits require target; only text waits require text. Do not supply url.");
    }
}

export async function waitForCondition(
    page: Page,
    locator: Locator | undefined,
    params: Static<typeof WaitParams>,
    timeout: number,
): Promise<void> {
    if (params.condition === "url") {
        const expected = normalizeBrowserUrl(params.url!);
        await page.waitForURL((url) => url.href === expected, { timeout, waitUntil: "commit" });
    } else if (params.condition === "text") {
        const literal = params.text!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        await locator!.filter({ hasText: new RegExp(`^${literal}$`, "u") }).waitFor({ state: "attached", timeout });
    } else {
        await locator!.waitFor({ state: params.condition, timeout });
    }
}

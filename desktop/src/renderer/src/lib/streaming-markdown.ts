function unescapedTokenCount(value: string, token: "**" | "__"): number {
    let count = 0;
    for (let index = 0; index <= value.length - token.length; index += 1) {
        if (value[index] === "\\") {
            index += 1;
            continue;
        }

        if (value.slice(index, index + token.length) === token) {
            count += 1;
            index += token.length - 1;
        }
    }

    return count;
}

function outsideInlineCode(value: string): { text: string; unclosed: boolean } {
    let text = "";
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === "\\") {
            if (!inCode) {
                text += character;
                if (index + 1 < value.length) {
                    text += value[index + 1];
                }
            }

            index += 1;
            continue;
        }

        if (character === "`") {
            inCode = !inCode;
            continue;
        }

        if (!inCode) {
            text += character;
        }
    }

    return { text, unclosed: inCode };
}

/**
 * Add display-only closing delimiters for common constructs that may be split
 * across streaming deltas. The authoritative content remains unchanged.
 */
export function stabilizeStreamingMarkdown(content: string): string {
    const fences = Array.from(content.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*/gu));
    if (fences.length % 2 === 1) {
        const marker = fences.at(-1)?.[1] ?? "```";

        return `${content}\n${marker}`;
    }

    const inline = outsideInlineCode(content);
    let suffix = inline.unclosed ? "`" : "";

    if (unescapedTokenCount(inline.text, "**") % 2 === 1) {
        suffix += "**";
    }

    if (unescapedTokenCount(inline.text, "__") % 2 === 1) {
        suffix += "__";
    }

    return `${content}${suffix}`;
}

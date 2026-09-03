export interface DiffLine {
    key: string;
    kind: "add" | "remove" | "context" | "meta" | "hunk";
    oldLine?: number;
    newLine?: number;
    content: string;
}

export function parseDiff(diff: string): DiffLine[] {
    let oldLine = 0;
    let newLine = 0;

    return diff.split("\n").map((line, index) => {
        if (line.startsWith("@@")) {
            const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
            oldLine = Number(match?.[1] ?? 0);
            newLine = Number(match?.[2] ?? 0);

            return { key: `hunk-${index}`, kind: "hunk", content: line };
        }

        if (line.startsWith("+") && !line.startsWith("+++")) {
            const value = { key: `add-${index}`, kind: "add" as const, newLine, content: line };
            newLine += 1;

            return value;
        }

        if (line.startsWith("-") && !line.startsWith("---")) {
            const value = { key: `remove-${index}`, kind: "remove" as const, oldLine, content: line };
            oldLine += 1;

            return value;
        }

        if (line.startsWith(" ")) {
            const value = {
                key: `context-${index}`,
                kind: "context" as const,
                oldLine,
                newLine,
                content: line,
            };
            oldLine += 1;
            newLine += 1;

            return value;
        }

        return { key: `meta-${index}`, kind: "meta", content: line };
    });
}

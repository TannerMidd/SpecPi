import { describe, expect, it } from "vitest";
import { parseDiff } from "../../src/renderer/src/lib/diff";

describe("diff projection", () => {
    it("tracks old and new line numbers across a hunk", () => {
        const lines = parseDiff(
            [
                "diff --git a/file.ts b/file.ts",
                "@@ -10,3 +10,4 @@ function run()",
                " context",
                "-removed",
                "+added",
                "+another",
            ].join("\n"),
        );

        expect(lines).toMatchObject([
            { kind: "meta" },
            { kind: "hunk" },
            { kind: "context", oldLine: 10, newLine: 10 },
            { kind: "remove", oldLine: 11 },
            { kind: "add", newLine: 11 },
            { kind: "add", newLine: 12 },
        ]);
    });

    it("does not treat file headers as changed lines", () => {
        const lines = parseDiff(["--- a/file.ts", "+++ b/file.ts"].join("\n"));

        expect(lines.map((line) => line.kind)).toEqual(["meta", "meta"]);
    });
});

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import filters from "../vscode/src/file-filters.js";

const { compileSettingExcludes, expandBraces, isIgnored, isSettingExcluded, parseIgnoreFile } = filters;

function ignoreRules(text) {
    return parseIgnoreFile(text);
}

function hidden(rules, relativePath, isDirectory = false) {
    return isIgnored(rules, relativePath, isDirectory);
}

test("gitignore matches unanchored basename patterns at any depth", () => {
    const rules = ignoreRules("*.log\nnode_modules\n");
    assert.equal(hidden(rules, "debug.log"), true);
    assert.equal(hidden(rules, "src/nested/debug.log"), true);
    assert.equal(hidden(rules, "src/keep.txt"), false);
    assert.equal(hidden(rules, "node_modules/package/index.js"), true);
    assert.equal(hidden(rules, "a/node_modules/x.js"), true);
    assert.equal(hidden(rules, "src/node"), false);
});

test("gitignore directory rules cover files beneath and never files sharing the name", () => {
    const rules = ignoreRules("build/\n");
    assert.equal(hidden(rules, "build", true), true);
    assert.equal(hidden(rules, "build/output.js"), true);
    assert.equal(hidden(rules, "a/deep/build/output.js"), true);
    assert.equal(hidden(rules, "build", false), false);
    assert.equal(hidden(rules, "builder.js"), false);
});

test("gitignore anchors patterns containing a slash and honors a leading slash", () => {
    const rules = ignoreRules("/logs/root.txt\ndocs/guide.md\n");
    assert.equal(hidden(rules, "logs/root.txt"), true);
    assert.equal(hidden(rules, "nested/logs/root.txt"), false);
    assert.equal(hidden(rules, "docs/guide.md"), true);
    assert.equal(hidden(rules, "site/docs/guide.md"), false);
});

test("gitignore applies trailing-slash anchoring to directories at any depth", () => {
    const rules = ignoreRules("cache/\n/root-cache/\n");
    assert.equal(hidden(rules, "deep/cache", true), true);
    assert.equal(hidden(rules, "root-cache", true), true);
    assert.equal(hidden(rules, "a/root-cache", true), false);
});

test("gitignore negation uses last-match precedence", () => {
    const rules = ignoreRules("*.log\n!keep.log\n!important/\n");
    assert.equal(hidden(rules, "keep.log"), false);
    assert.equal(hidden(rules, "other.log"), true);
    assert.equal(hidden(rules, "important/notes.txt", false), false);
    assert.equal(hidden(rules, "important", true), false);
});

test("gitignore understands **, *, ?, and character classes", () => {
    const rules = ignoreRules("**/temp.txt\nfoo/**\na/**/b\nfile?.txt\n[abc].txt\n");
    assert.equal(hidden(rules, "temp.txt"), true);
    assert.equal(hidden(rules, "x/y/temp.txt"), true);
    assert.equal(hidden(rules, "foo/inside/any.js"), true);
    assert.equal(hidden(rules, "foo", false), false);
    assert.equal(hidden(rules, "a/b"), true);
    assert.equal(hidden(rules, "a/intermediate/b"), true);
    assert.equal(hidden(rules, "file1.txt"), true);
    assert.equal(hidden(rules, "file12.txt"), false);
    assert.equal(hidden(rules, "b.txt"), true);
    assert.equal(hidden(rules, "d.txt"), false);
});

test("gitignore skips comments, blanks, and trims unescaped trailing spaces", () => {
    const rules = ignoreRules("# comment\n\n*.log   \nkeep\\ me.txt\n");
    assert.deepEqual(rules.length, 2);
    assert.equal(hidden(rules, "run.log"), true);
    assert.equal(hidden(rules, "keep me.txt"), true);
    assert.equal(hidden(rules, "keep\\ me.txt"), false);
});

test("gitignore escapes literal special characters with backslashes", () => {
    const rules = ignoreRules("\\!important.txt\nweird\\ name.txt\n");
    assert.equal(hidden(rules, "!important.txt"), true);
    assert.equal(hidden(rules, "important.txt"), false);
    assert.equal(hidden(rules, "weird name.txt"), true);
});

test("settings excludes compile anchored globs with braces and booleans", () => {
    const rules = compileSettingExcludes(
        { "**/*.gen.ts": true, dist: true, "{a,b}/c.txt": false },
        {
            "**/*.tmp": true,
        },
    );
    assert.equal(isSettingExcluded(rules, "src/out.gen.ts"), true);
    assert.equal(isSettingExcluded(rules, "dist/inner.js"), true);
    assert.equal(isSettingExcluded(rules, "nested/dist/inner.js"), false);
    assert.equal(isSettingExcluded(rules, "a/c.txt"), false);
    assert.equal(isSettingExcluded(rules, "c/c.txt"), false);
    assert.equal(isSettingExcluded(rules, "scratch.tmp"), true);
    assert.equal(isSettingExcluded(rules, "scratch.tmp0"), false);
});

test("settings false disables only the same glob key, including search overrides", () => {
    const rules = compileSettingExcludes({ "**/*.log": true, "**/keep.log": false }, undefined);
    assert.equal(isSettingExcluded(rules, "keep.log"), true);
    const overridden = compileSettingExcludes({ "**/*.log": true }, { "**/*.log": false });
    assert.equal(isSettingExcluded(overridden, "keep.log"), false);
    const independent = compileSettingExcludes({ "**/*.log": true }, { "**/keep.log": false });
    assert.equal(isSettingExcluded(independent, "keep.log"), true);
});

test("settings excludes treat directory entries as covering their contents", () => {
    const rules = compileSettingExcludes({ dist: true }, undefined);
    assert.equal(isSettingExcluded(rules, "dist", true), true);
    assert.equal(isSettingExcluded(rules, "dist/file.js"), true);
    assert.equal(isSettingExcluded(rules, "a/dist/file.js"), false);
});

test("brace expansion expands alternatives without recursing past its budget", () => {
    assert.deepEqual(expandBraces("{a,b}/c.txt"), ["a/c.txt", "b/c.txt"]);
    assert.deepEqual(expandBraces("plain.txt"), ["plain.txt"]);
    assert.deepEqual(expandBraces("unclosed{brace"), ["unclosed{brace"]);
    assert.deepEqual(expandBraces("nested/{x,{y,z}}.txt"), ["nested/x.txt", "nested/y.txt", "nested/z.txt"]);
});

test("parent negations reopen traversal without unignoring independently excluded descendants", () => {
    const rules = ignoreRules("*\n!*/\n!*.md\n");
    assert.equal(hidden(rules, "src", true), false);
    assert.equal(hidden(rules, "src/private.txt"), true);
    assert.equal(hidden(rules, "src/deep/private.txt"), true);
    assert.equal(hidden(rules, "src/readme.md"), false);
    assert.equal(hidden(ignoreRules("build/\n!build/keep.txt\n"), "build/keep.txt"), true);
    assert.equal(hidden(ignoreRules("build/*\n!build/keep.txt\n"), "build/keep.txt"), false);
});

test("malformed character classes do not discard valid ignore or settings rules", () => {
    const rules = ignoreRules("private-notes/\n[z-a]\n*.log\n");
    assert.equal(hidden(rules, "private-notes/draft.txt"), true);
    assert.equal(hidden(rules, "error.log"), true);
    assert.equal(hidden(rules, "public.txt"), false);
    const settings = compileSettingExcludes({ "[z-a]": true, "**/*.log": true }, {});
    assert.equal(isSettingExcluded(settings, "error.log"), true);
});

test("adversarial glob matching terminates without regex backtracking", () => {
    // A child deadline makes a regression fail instead of hanging the test host.
    const file = fileURLToPath(new URL("../vscode/src/file-filters.js", import.meta.url));
    const script = `const assert = require("node:assert/strict");
        const f = require(${JSON.stringify(file)});
        const pattern = "*a".repeat(30) + "b";
        assert.equal(f.isIgnored(f.parseIgnoreFile(pattern), "a".repeat(100)), false);
        assert.equal(f.isSettingExcluded(f.compileSettingExcludes({[pattern]: true}), "a".repeat(100)), false);
        assert.equal(f.isIgnored(f.parseIgnoreFile(pattern), "a".repeat(100) + "b"), true);`;
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 5000, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
});

test("matching and intermediate brace expansion enforce explicit work limits", () => {
    const pattern = "*a".repeat(2000);
    assert.throws(() => hidden(ignoreRules(pattern), "a".repeat(4000)), /work limit/u);
    assert.throws(() => ignoreRules("a".repeat(4097)), /4096 characters/u);
    assert.throws(() => ignoreRules(Array.from({ length: 1001 }, (_, i) => `file${i}`).join("\n")), /1000 rules/u);
    const expansion = Array(5)
        .fill("{" + Array(64).fill("x").join(",") + "}")
        .join("");
    assert.deepEqual(expandBraces(expansion), [expansion]);
});

test("malformed or hostile paths are never matched", () => {
    const rules = ignoreRules("secret.txt");
    assert.equal(hidden(rules, ""), false);
    assert.equal(hidden(rules, "..\\secret.txt"), false);
    assert.equal(hidden(rules, "../secret.txt"), false);
    assert.equal(hidden(rules, undefined), false);
    assert.equal(isSettingExcluded(compileSettingExcludes({ "secret.txt": true }, undefined), "../secret.txt"), false);
});

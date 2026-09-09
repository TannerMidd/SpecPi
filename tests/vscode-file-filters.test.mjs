import assert from "node:assert/strict";
import test from "node:test";
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

test("settings excludes re-include through later false entries", () => {
    const rules = compileSettingExcludes({ "generated/**": true, "generated/keep": false }, undefined);
    assert.equal(isSettingExcluded(rules, "generated/made.js"), true);
    assert.equal(isSettingExcluded(rules, "generated/keep"), false);
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

test("malformed or hostile paths are never matched", () => {
    const rules = ignoreRules("secret.txt");
    assert.equal(hidden(rules, ""), false);
    assert.equal(hidden(rules, "..\\secret.txt"), false);
    assert.equal(hidden(rules, "../secret.txt"), false);
    assert.equal(hidden(rules, undefined), false);
    assert.equal(isSettingExcluded(compileSettingExcludes({ "secret.txt": true }, undefined), "../secret.txt"), false);
});

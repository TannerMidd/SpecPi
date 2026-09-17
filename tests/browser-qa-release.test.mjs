import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { BROWSER_TOOL_NAMES } from "../extensions/workflow-controls/capabilities.mjs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("browser QA releases are independent and publish only the validated candidate through the protected environment", () => {
    const root = read(".github/workflows/npm-publish.yml");
    const workflow = read(".github/workflows/browser-qa-publish.yml");
    const packageJson = JSON.parse(read("packages/browser-qa/package.json"));
    assert.match(root, /if: startsWith\(github\.event\.release\.tag_name, 'v'\)/u);
    assert.match(workflow, /if: startsWith\(github\.event\.release\.tag_name, 'browser-qa-v'\)/u);
    assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/u);
    assert.match(workflow, /test "\$\{GITHUB_REF_NAME\}" = "browser-qa-v\$\{VERSION\}"/u);
    assert.match(workflow, /os: \[ubuntu-latest, windows-latest, macos-latest\]/u);
    assert.match(workflow, /check:package -- --artifact "\$\{TARBALL\}"/u);
    assert.match(workflow, /publish:\s+needs: validate/u);
    assert.match(workflow, /environment: npm/u);
    assert.match(workflow, /id-token: write/u);
    assert.match(workflow, /npm publish --ignore-scripts --access public --provenance --tag/u);
    assert.match(workflow, /check-release-order\.mjs advance/u);
    assert.match(workflow, /dist\.integrity/u);
    assert.match(workflow, /dist\.attestations\.url/u);
    assert.equal(packageJson.name, "specpi-browser-qa");
    assert.equal(packageJson.dependencies.playwright, "1.62.1");
    assert.deepEqual(packageJson.pi.extensions, ["./src/index.ts"]);
    assert.equal(packageJson.scripts.postinstall, undefined);
});

// The capability loader activates Browser QA by tool name, because the package ships as an
// immutable release that SpecPi cannot import from. A name that drifts out of that release
// would activate nothing and report success, so compare the list against the real source.
test("the capability loader's Browser QA tool names match the package it activates", () => {
    const source = read("packages/browser-qa/src/index.ts");
    const registered = [...source.matchAll(/^\s+name: "(browser_[a-z_]+)",$/gmu)].map((match) => match[1]);
    assert.ok(registered.length > 0, "found no browser tool registrations to compare against");
    assert.deepEqual([...BROWSER_TOOL_NAMES].sort(), [...new Set(registered)].sort());
});

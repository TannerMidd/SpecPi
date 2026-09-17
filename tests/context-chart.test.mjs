import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { resolveCapabilityRows, resolveRows, staleChartFiles, ROWS } from "../scripts/context-chart.mjs";

const report = JSON.parse(
    fs.readFileSync(new URL("../site/research/context-measurement.json", import.meta.url), "utf8"),
);

test("published context charts match the recorded installed-profile measurements", () => {
    assert.equal(report.schema, 1);
    assert.equal(report.packages.length, 7);
    assert.equal(report.loadedExtensionCount, 9);
    assert.deepEqual(staleChartFiles(report), []);
    const [stock, defaults, openCode, enabled, ohMyPi] = report.results;

    // Oh My Pi and OpenCode are separate harnesses measured on the same terms, never
    // published figures. The Oh My Pi row may be carried forward from a same-terms run
    // recorded in `carriedForward` while its own runtime stays broken; every other row is
    // from this record's run.
    assert.equal(stock.label, "Pi (stock)");
    assert.equal(defaults.label, "SpecPi default");
    assert.equal(openCode.label, "OpenCode");
    assert.equal(openCode.harness, `OpenCode ${report.opencodeVersion}`);
    assert.equal(enabled.label, "SpecPi enabled");
    assert.equal(ohMyPi.label, "Oh My Pi");
    assert.equal(ohMyPi.harness, `Oh My Pi ${report.ohMyPiVersion}`);
    assert.ok(openCode.requestSha256);
    assert.ok(ohMyPi.requestSha256);
    assert.ok(openCode.installedGuidance === undefined);
    assert.ok(ohMyPi.installedGuidance === undefined);
    for (const row of [stock, defaults, enabled]) {
        assert.equal(row.harness, "Pi");
    }

    assert.equal(stock.installedGuidance, false);
    assert.equal(defaults.installedGuidance, true);
    assert.equal(enabled.installedGuidance, true);
    for (const row of report.results) {
        assert.equal(row.toolCount, row.toolNames.length);
    }

    for (const name of [
        "browser_open",
        "delegate",
        "web_search",
        "fetch_content",
        "get_search_content",
        "source_check",
    ]) {
        assert.ok(!defaults.toolNames.includes(name));
        assert.ok(enabled.toolNames.includes(name));
    }

    // Wishlist tools are always active; collection consent and the human
    // selection gate execution, not visibility.
    for (const name of ["report_capability_gap", "record_harness_contract", "finish_harness_improvement"]) {
        assert.ok(defaults.toolNames.includes(name), name);
        assert.ok(enabled.toolNames.includes(name), name);
    }
});

test("chart rejects missing rows and invalid counts instead of substituting figures", () => {
    assert.throws(() => resolveRows([]), /needs a measurement/u);
    for (const value of [-1, NaN, Infinity, "10536"]) {
        const rows = structuredClone(report.results);
        rows[0].toolSchemaChars = value;
        assert.throws(() => resolveRows(rows), /Invalid toolSchemaChars/u);
    }
});

// HarnessTax covers Claude Code, Codex CLI and Pi only. Any other harness entered as a
// study row would be attributing one of our own measurements to a paper that never made it.
test("only harnesses the study covers may carry published figures", () => {
    const studied = ["Codex CLI", "Claude Code", "Pi stock"];
    for (const row of ROWS.filter((entry) => entry.study)) {
        assert.ok(studied.includes(row.label), `${row.label} is not a harness HarnessTax measured`);
    }

    assert.ok(
        ROWS.some((row) => row.label === "Oh My Pi" && row.measured && !row.study),
        "Oh My Pi is our measurement and must stay a measured row",
    );
    assert.ok(
        ROWS.some((row) => row.label === "OpenCode" && row.measured && !row.study),
        "OpenCode is our measurement and must stay a measured row",
    );
});

// The footnote names harness versions, so it is written from the record rather than by hand.
test("chart footnotes track the measured versions and pin count", () => {
    const light = fs.readFileSync(new URL("../site/media/context-chart-light.svg", import.meta.url), "utf8");
    assert.match(
        light,
        new RegExp(`Pi ${report.piVersion}, omp ${report.ohMyPiVersion} and opencode ${report.opencodeVersion}`, "u"),
    );
    assert.match(light, new RegExp(`all ${report.packages.length} pins`, "u"));
    assert.deepEqual(staleChartFiles({ ...report, piVersion: "9.9.9" }).includes("README.md"), false);
    assert.ok(staleChartFiles({ ...report, piVersion: "9.9.9" }).includes("site/media/context-chart-light.svg"));
});

test("capability groups partition the enabled profile's measured tool schema", () => {
    const rows = resolveCapabilityRows(report.results);
    const enabled = report.results.find((row) => row.label === "SpecPi enabled");
    const grouped = rows.reduce((total, row) => total + row.chars, 0);
    const counted = rows.reduce((total, row) => total + Number.parseInt(row.tools, 10), 0);

    // Exhaustive and disjoint: the groups account for every measured tool, and their sizes
    // differ from the whole array only by the delimiters JSON puts between definitions.
    assert.equal(counted, enabled.toolCount);
    assert.equal(grouped, enabled.toolSchemaChars - (enabled.toolCount + 1));
    assert.deepEqual(
        rows.filter((row) => row.optional).map((row) => row.label),
        ["Browser QA", "Delegation", "Web access"],
    );
});

test("capability chart refuses a tool no group claims or a stale default label", () => {
    const orphan = structuredClone(report.results);
    const enabled = orphan.find((row) => row.label === "SpecPi enabled");
    enabled.toolNames.push("some_new_tool");
    enabled.toolChars.some_new_tool = 100;
    assert.throws(() => resolveCapabilityRows(orphan), /No capability group claims: some_new_tool/u);

    // A package that starts shipping an opt-in group by default must fail the render
    // rather than keep the "hidden until switched on" label.
    const leaked = structuredClone(report.results);
    leaked.find((row) => row.label === "SpecPi default").toolNames.push("web_search");
    assert.throws(() => resolveCapabilityRows(leaked), /Web access is labelled opt-in/u);

    assert.throws(() => resolveCapabilityRows([]), /needs both/u);
});

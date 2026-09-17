#!/usr/bin/env node
// Render the first-call context chart everywhere it is published, from one set of numbers.
//
// The chart appears in three places that must agree: inline in the research page, where it
// picks up the site's theme tokens, and as two standalone SVGs the README references through
// <picture>. GitHub renders a README image as <img>, which loads no external stylesheet and
// no external font, so the standalone pair carries its own palette and embeds the face the
// site links. Keeping one renderer means a measurement moves in one place.
//
// Two charts are published from one measurement. The comparison chart places the installed
// profiles beside HarnessTax's published figures for other harnesses, which are the only
// rows this repository does not measure and are drawn dimmed for that reason alone. The
// capability chart decomposes the enabled profile's tool schema into the groups a human
// turns on, so "what does browser QA cost" has an answer that is not an estimate.
//
// This module only renders: `node scripts/measure-context.mjs --chart` captures and writes.
// staleChartFiles can verify the published copies against the saved measurement record.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Layout. The scale rounds up to GRID_STEP; room beyond PLOT holds the value label.
const WIDTH = 720;
const LEFT = 175;
const PLOT = 480;
const GRID_STEP = 10000;
const BAR_HEIGHT = 22;
const ROW_STEP = 50;
const FIRST_BAR_Y = 30;
// The tool-schema segment is drawn short of its true width, which opens a hairline between the
// two segments without moving the instructions segment off the scale.
const SEGMENT_GAP = 2;
const VALUE_GAP = 8;
const LABEL_GAP = 10;
const GRID_TOP = 22;
const LEGEND_Y = 6;
const INSTRUCTION_OPACITY = ".42";

const TITLE = "Characters sent on the first model call";

// The Pi release HarnessTax measured on, which is not the one this repository measures.
const STUDY_PI_VERSION = "0.85.1";
const AXIS_LABEL = "Characters: tool schemas + system/developer instructions";

// The capability chart shares the renderer but not the scale: its largest group is an order
// of magnitude below Claude Code's total, so a shared axis would flatten every bar.
const CAP_PLOT = 440;
const CAP_GRID_STEP = 2000;
const CAP_ROW_STEP = 46;
const CAP_TITLE = "What each capability adds to the tool schema";
const CAP_AXIS_LABEL = "Characters of tool-definition JSON in the enabled profile";
const OPTIONAL_OPACITY = "0.55";

// Categorical hues are fixed per entity and validated against both surfaces; the row label
// carries identity alongside colour, so the chart survives being read in greyscale. The hex
// pairs mirror the tokens in site/research.css, which is what keeps the inline chart and the
// standalone pair looking like one figure.
const PALETTES = {
    light: {
        line: "#d6dce3",
        muted: "#57616f",
        text: "#14181f",
        pi: "#1b5fd6",
        specpi: "#157f4c",
        codex: "#9a5b00",
        opencode: "#c2410c",
        omp: "#8c6ebd",
        claudecode: "#a3197f",
    },
    dark: {
        line: "#333c4a",
        muted: "#a9b3c2",
        text: "#eef1f6",
        pi: "#5a8ae8",
        specpi: "#3f9e6b",
        codex: "#c08420",
        opencode: "#f0883e",
        omp: "#864ad2",
        claudecode: "#c25299",
    },
};

// The inline chart defers to the page instead of carrying colour, so a theme switch repaints it
// without re-rendering. Text styling comes from .chart's classes rather than attributes.
const TOKENS = {
    line: "var(--line)",
    muted: "var(--muted)",
    text: "var(--text)",
    pi: "var(--ct-pi)",
    specpi: "var(--ct-specpi)",
    codex: "var(--ct-codex)",
    opencode: "var(--ct-opencode)",
    omp: "var(--ct-omp)",
    claudecode: "var(--ct-claudecode)",
};

// Text roles, as the standalone files spell them. The inline file names the matching class in
// site/research.css, which sets the same size, fill and weight.
const TEXT_ROLES = {
    ax: { size: 11, fill: "muted" },
    lb: { size: 11.5, fill: "muted" },
    row: { size: 13, fill: "text", weight: 600 },
    sub: { size: 11, fill: "muted" },
    val: { size: 12, fill: "text", weight: 600 },
};

// Rows in chart order, ascending by total. Measured rows come from
// scripts/measure-context.mjs: a renamed configuration fails loudly here instead of dropping
// a bar, and --chart refuses to write while any measured row is missing. Study rows carry
// HarnessTax's published figures (Pan, Yang, Arabzadeh, Chiang, Stoica and Zaharia,
// 16 September 2026, https://harnesstax.github.io/), taken under the study's configuration.
// That study covers Claude Code, Codex CLI and Pi only, so no other harness may be entered
// as a study row -- Oh My Pi's and OpenCode's bars are our own measurements and stay
// measured rows.
//
// Reduced opacity means "this figure is not ours" and nothing else, which is what lets the
// footnote name the method difference without implicating a row we measured.
const ROWS = [
    { label: "Pi stock", hue: "pi", measured: "Pi (stock)" },
    { label: "SpecPi default", hue: "specpi", measured: "SpecPi default" },
    { label: "OpenCode", hue: "opencode", measured: "OpenCode" },
    { label: "SpecPi enabled", hue: "specpi", measured: "SpecPi enabled" },
    {
        label: "Codex CLI",
        hue: "codex",
        study: { tools: "7.4 tools", toolSchemaChars: 18114, instructionChars: 23502 },
    },
    { label: "Oh My Pi", hue: "omp", measured: "Oh My Pi" },
    {
        label: "Claude Code",
        hue: "claudecode",
        study: { tools: "23 tools", toolSchemaChars: 76995, instructionChars: 13465 },
    },
];

// The enabled profile's tool schema, split into the groups a human actually switches on.
// Every tool in the measured request must be claimed by exactly one group, and whether a
// group ships in the default profile is checked against the measurement rather than
// declared here, so a package that changes its default visibility fails the render.
const CAPABILITY_GROUPS = [
    { label: "Pi built-ins", names: ["bash", "edit", "read", "write"] },
    {
        label: "Improvement loop",
        names: ["report_capability_gap", "record_harness_contract", "finish_harness_improvement"],
    },
    { label: "Goals", names: ["create_goal", "get_goal"] },
    { label: "Browser QA", prefix: "browser_", command: "/browser on" },
    { label: "Delegation", names: ["delegate"], command: "/delegate on" },
    {
        label: "Web access",
        names: ["web_search", "source_check", "fetch_content", "get_search_content"],
        command: "/webaccess on",
    },
];

// Both charts end at the same distance below their last bar, so adding or removing a row
// moves the footnotes and the viewBox together instead of leaving a band of dead space.
function gridBottomFor(rowCount, rowStep) {
    return FIRST_BAR_Y + (rowCount - 1) * rowStep + BAR_HEIGHT + 4;
}

function footnoteY(gridBottom, line) {
    return gridBottom + 66 + line * 18;
}

const HEIGHT = footnoteY(gridBottomFor(ROWS.length, ROW_STEP), 2) + 16;
const CAP_HEIGHT = footnoteY(gridBottomFor(CAPABILITY_GROUPS.length, CAP_ROW_STEP), 0) + 16;

/** Trim a computed coordinate to sub-pixel precision, so re-rendering is stable. */
function num(value) {
    return String(Number(value.toFixed(3)));
}

function group(value) {
    return value.toLocaleString("en-US");
}

/**
 * Resolve the rows against a measurement run. Pass the results array from
 * measure-context.mjs; every `measured` row must be present in it. Study rows carry
 * their published figures inline and need no measurement.
 */
function resolveRows(results = []) {
    const byLabel = new Map(results.map((result) => [result.label, result]));

    return ROWS.map((row) => {
        if (row.study) {
            for (const key of ["toolSchemaChars", "instructionChars"]) {
                if (!Number.isSafeInteger(row.study[key]) || row.study[key] < 0) {
                    throw new Error(`Invalid study ${key} for ${row.label}`);
                }
            }

            return {
                ...row,
                tools: row.study.tools,
                toolSchemaChars: row.study.toolSchemaChars,
                instructionChars: row.study.instructionChars,
            };
        }

        const measured = byLabel.get(row.measured);
        if (!measured) {
            throw new Error(`The chart needs a measurement for "${row.measured}", which this run did not produce.`);
        }

        for (const key of ["toolCount", "toolSchemaChars", "instructionChars"]) {
            if (!Number.isSafeInteger(measured[key]) || measured[key] < 0) {
                throw new Error(`Invalid ${key} for ${row.measured}`);
            }
        }

        return {
            ...row,
            tools: `${measured.toolCount} tools`,
            toolSchemaChars: measured.toolSchemaChars,
            instructionChars: measured.instructionChars,
        };
    });
}

/**
 * Text and fill helpers for one surface. `mode` is "inline" for the research page, which
 * styles text through site/research.css, or "standalone" for the README pair, which carries
 * its own palette because GitHub loads no external stylesheet for a README image.
 */
function painter({ mode, palette }) {
    const inline = mode === "inline";
    const colour = (name) => (inline ? TOKENS[name] : palette[name]);
    const text = (x, y, role, content, { anchor } = {}) => {
        const spec = TEXT_ROLES[role];
        const parts = [`x="${num(x)}"`, `y="${num(y)}"`];
        if (anchor) {
            parts.push(`text-anchor="${anchor}"`);
        }

        if (inline) {
            parts.push(`class="ct-${role}"`);
        } else {
            parts.push(`font-size="${spec.size}"`, `fill="${palette[spec.fill]}"`);
            if (spec.weight) {
                parts.push(`font-weight="${spec.weight}"`);
            }
        }

        return `<text ${parts.join(" ")}>${content}</text>`;
    };

    return { colour, text };
}

/** Gridlines and their labels, down to the given baseline. */
function axisMarks({ colour, text }, { axis, step, bottom, scale }) {
    const parts = [];
    for (let value = 0; value <= axis; value += step) {
        const x = LEFT + scale(value);
        parts.push(
            `<line x1="${num(x)}" y1="${GRID_TOP}" x2="${num(x)}" y2="${bottom}" ` +
                `stroke="${colour("line")}" opacity=".6" />`,
            text(x, bottom + 20, "ax", `${value / 1000}k`, { anchor: "middle" }),
        );
    }

    return parts;
}

/** Round an axis up to the next gridline so the longest bar sits inside the plot. */
function axisMax(values, step) {
    return Math.max(step, Math.ceil(Math.max(...values) / step) * step);
}

/**
 * The three footnote lines, written from the measurement rather than kept in step by hand,
 * so re-measuring on a new harness version cannot leave a stale claim on the chart.
 */
function footnotes(report) {
    const versions = [
        `Pi ${report.piVersion}`,
        report.ohMyPiVersion && `omp ${report.ohMyPiVersion}`,
        report.opencodeVersion && `opencode ${report.opencodeVersion}`,
    ].filter(Boolean);
    const measured =
        versions.length > 2 ? `${versions.slice(0, -1).join(", ")} and ${versions.at(-1)}` : versions.join(" and ");

    return [
        `Solid rows measured here: ${measured}, synthetic provider, all ${report.packages.length} pins.`,
        "Dimmed rows: HarnessTax figures for Codex CLI and Claude Code, taken on",
        `Pi ${STUDY_PI_VERSION} with real providers. Characters, not tokens or cost.`,
    ];
}

/** The comparison chart, as SVG body markup. */
function renderBody(rows, { mode, palette, notes }) {
    const axis = axisMax(
        rows.map((row) => row.toolSchemaChars + row.instructionChars),
        GRID_STEP,
    );
    const scale = (chars) => PLOT * (chars / axis);
    const { colour, text } = painter({ mode, palette });
    const gridBottom = gridBottomFor(rows.length, ROW_STEP);
    const parts = [];

    // The right margin leaves the widest bar's value label inside the viewBox.
    parts.push(
        ...axisMarks({ colour, text }, { axis, step: GRID_STEP, bottom: gridBottom, scale }),
        text(LEFT + PLOT / 2, gridBottom + 44, "lb", AXIS_LABEL, { anchor: "middle" }),
    );

    rows.forEach((row, index) => {
        const barY = FIRST_BAR_Y + index * ROW_STEP;
        const schemaWidth = scale(row.toolSchemaChars);
        const instructionX = LEFT + schemaWidth;
        const instructionWidth = scale(row.instructionChars);
        const fill = colour(row.hue);
        const segment = (x, width, opacity, name, chars) =>
            `<rect x="${num(x)}" y="${barY}" width="${num(width)}" height="${BAR_HEIGHT}" rx="4" ` +
            `fill="${fill}" opacity="${opacity}">` +
            `<title>${row.label} ${name}: ${group(chars)} chars</title></rect>`;

        parts.push(
            text(LEFT - LABEL_GAP, barY + 13, "row", row.label, { anchor: "end" }),
            text(LEFT - LABEL_GAP, barY + 28, "sub", row.tools, { anchor: "end" }),
            segment(
                LEFT,
                Math.max(0, schemaWidth - SEGMENT_GAP),
                row.study ? OPTIONAL_OPACITY : "1",
                "tool schema",
                row.toolSchemaChars,
            ),
            segment(instructionX, instructionWidth, INSTRUCTION_OPACITY, "instructions", row.instructionChars),
            text(
                instructionX + instructionWidth + VALUE_GAP,
                barY + 16,
                "val",
                group(row.toolSchemaChars + row.instructionChars),
            ),
        );
    });

    parts.push(
        `<rect x="${LEFT}" y="${LEGEND_Y}" width="11" height="11" rx="2" fill="${colour("muted")}" />`,
        text(LEFT + 17, LEGEND_Y + 10, "ax", "tool schemas"),
        `<rect x="310" y="${LEGEND_Y}" width="11" height="11" rx="2" fill="${colour("muted")}" ` +
            `opacity="${INSTRUCTION_OPACITY}" />`,
        text(327, LEGEND_Y + 10, "ax", "instructions"),
        ...notes.map((note, line) => text(LEFT, footnoteY(gridBottom, line), "ax", note)),
    );

    return parts.join("");
}

/**
 * Split the enabled profile's measured tool schemas into capability groups. Every measured
 * tool must be claimed exactly once, and each group's default-profile visibility is read
 * from the default measurement rather than trusted from CAPABILITY_GROUPS.
 */
function resolveCapabilityRows(results = []) {
    const byLabel = new Map(results.map((result) => [result.label, result]));
    const enabled = byLabel.get("SpecPi enabled");
    const defaults = byLabel.get("SpecPi default");
    if (!enabled || !defaults) {
        throw new Error('The capability chart needs both "SpecPi default" and "SpecPi enabled" measurements.');
    }

    const claimed = new Set();
    const rows = CAPABILITY_GROUPS.map((group_) => {
        const names = enabled.toolNames.filter((name) =>
            group_.prefix ? name.startsWith(group_.prefix) : group_.names.includes(name),
        );
        if (names.length === 0) {
            throw new Error(`No measured tools matched the ${group_.label} group.`);
        }

        let chars = 0;
        for (const name of names) {
            if (claimed.has(name)) {
                throw new Error(`${name} is claimed by more than one capability group.`);
            }

            const value = enabled.toolChars[name];
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error(`Invalid measured schema size for ${name}.`);
            }

            claimed.add(name);
            chars += value;
        }

        // Declaring a group optional is not enough: the default profile has to agree, so a
        // package that starts shipping its tools visibly cannot keep an "opt-in" label.
        const inDefault = names.filter((name) => defaults.toolNames.includes(name));
        const optional = group_.command !== undefined;
        if (inDefault.length !== (optional ? 0 : names.length)) {
            throw new Error(
                `${group_.label} is labelled ${optional ? "opt-in" : "always offered"} but the default profile ` +
                    `offers ${inDefault.length} of its ${names.length} tools.`,
            );
        }

        return {
            label: group_.label,
            tools: `${names.length} tool${names.length === 1 ? "" : "s"}`,
            note: group_.command ?? "in default",
            optional,
            chars,
        };
    });

    const unclaimed = enabled.toolNames.filter((name) => !claimed.has(name));
    if (unclaimed.length > 0) {
        throw new Error(`No capability group claims: ${unclaimed.join(", ")}. Add it to CAPABILITY_GROUPS.`);
    }

    return rows;
}

/** The capability chart, as SVG body markup. */
function renderCapabilityBody(rows, { mode, palette }) {
    const axis = axisMax(
        rows.map((row) => row.chars),
        CAP_GRID_STEP,
    );
    const scale = (chars) => CAP_PLOT * (chars / axis);
    const { colour, text } = painter({ mode, palette });
    const gridBottom = gridBottomFor(rows.length, CAP_ROW_STEP);
    const parts = axisMarks({ colour, text }, { axis, step: CAP_GRID_STEP, bottom: gridBottom, scale });
    parts.push(text(LEFT + CAP_PLOT / 2, gridBottom + 44, "lb", CAP_AXIS_LABEL, { anchor: "middle" }));
    rows.forEach((row, index) => {
        const barY = FIRST_BAR_Y + index * CAP_ROW_STEP;
        const width = scale(row.chars);
        parts.push(
            text(LEFT - LABEL_GAP, barY + 13, "row", row.label, { anchor: "end" }),
            text(LEFT - LABEL_GAP, barY + 28, "sub", `${row.tools} \u00b7 ${row.note}`, { anchor: "end" }),
            `<rect x="${LEFT}" y="${barY}" width="${num(width)}" height="${BAR_HEIGHT}" rx="4" ` +
                `fill="${colour("specpi")}" opacity="${row.optional ? OPTIONAL_OPACITY : "1"}">` +
                `<title>${row.label}: ${group(row.chars)} chars</title></rect>`,
            text(LEFT + width + VALUE_GAP, barY + 16, "val", group(row.chars)),
        );
    });

    const optional = rows.filter((row) => row.optional).reduce((total, row) => total + row.chars, 0);
    parts.push(
        `<rect x="${LEFT}" y="${LEGEND_Y}" width="11" height="11" rx="2" fill="${colour("specpi")}" />`,
        text(LEFT + 17, LEGEND_Y + 10, "ax", "offered by default"),
        `<rect x="310" y="${LEGEND_Y}" width="11" height="11" rx="2" fill="${colour("specpi")}" ` +
            `opacity="${OPTIONAL_OPACITY}" />`,
        text(327, LEGEND_Y + 10, "ax", "hidden until switched on"),
        text(
            LEFT,
            footnoteY(gridBottom, 0),
            "ax",
            `Withholding the opt-in groups keeps ${group(optional)} characters of tool schema out of every request.`,
        ),
    );

    return parts.join("");
}

/** The sentence a screen reader gets in place of the capability bars. */
function capabilityDescription(rows) {
    return (
        "Horizontal bar chart of the characters each capability group adds to the tool schema. " +
        `${rows.map((row) => `${row.label} ${group(row.chars)}`).join("; ")}. ` +
        `${rows
            .filter((row) => row.optional)
            .map((row) => row.label)
            .join(", ")} are hidden until switched on.`
    );
}

// Spoken rather than drawn: the row label's comma is punctuation in a list that is already
// delimited, and reads as a pause in the wrong place.
function figures(rows, separator) {
    return rows
        .map((row) => `${row.label.replace(",", "")} ${group(row.toolSchemaChars + row.instructionChars)}`)
        .join(separator);
}

/** The sentence a screen reader gets in place of the bars. */
function description(rows) {
    return (
        "Horizontal bar chart of characters a harness sends before any work happens. " +
        `${figures(rows, "; ")}. Each bar is split into tool schemas and instructions. ` +
        "The Pi, SpecPi, OpenCode and Oh My Pi rows were measured by this repository; the dimmed Codex CLI and " +
        "Claude Code rows are HarnessTax published figures taken under a different configuration."
    );
}

/** The README's alt text: the same figures, comma-separated, on one line. */
function altText(rows) {
    return `Bar chart of characters sent on the first model call: ${figures(rows, ", ")}.`;
}

function capabilityAltText(rows) {
    const figure = (row) => `${row.label} ${group(row.chars)}`;

    return (
        "Bar chart of tool-schema characters each capability adds: " +
        `${rows.map(figure).join(", ")}. ` +
        `${rows
            .filter((row) => row.optional)
            .map((row) => row.label)
            .join(", ")} are hidden until switched on.`
    );
}

/**
 * A standalone file for the README, carrying its own palette and font. GitHub renders a
 * README image as <img>, which loads neither the site stylesheet nor the site font.
 */
function standalone({ height, title, desc, body }) {
    const font = fs.readFileSync(path.join(root, "site", "fonts", "ibm-plex-sans.woff2")).toString("base64");

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" ` +
        `viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="chart-title chart-desc" ` +
        `font-family="Plex Sans, Arial, Helvetica, sans-serif">\n` +
        `    <title id="chart-title">${title}</title>\n` +
        `    <desc id="chart-desc">${desc}</desc>\n` +
        `    <style>@font-face{font-family:Plex Sans;font-style:normal;font-weight:100 900;` +
        `src:url(data:font/woff2;base64,${font}) format("woff2");}</style>\n` +
        `    ${body}\n` +
        `</svg>\n`
    );
}

function renderStandalone(rows, theme, notes) {
    return standalone({
        height: HEIGHT,
        title: TITLE,
        desc: description(rows),
        body: renderBody(rows, { mode: "standalone", palette: PALETTES[theme], notes }),
    });
}

function renderCapabilityStandalone(rows, theme) {
    return standalone({
        height: CAP_HEIGHT,
        title: CAP_TITLE,
        desc: capabilityDescription(rows),
        body: renderCapabilityBody(rows, { mode: "standalone", palette: PALETTES[theme] }),
    });
}

/** The research page's charts, themed by the page and named for assistive technology. */
function renderInline(rows, notes) {
    return (
        `<svg class="chart" id="chart-context" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" ` +
        `aria-labelledby="chart-context-title chart-context-desc" preserveAspectRatio="xMidYMid meet">` +
        `<title id="chart-context-title">${TITLE}</title>` +
        `<desc id="chart-context-desc">${description(rows)}</desc>` +
        `${renderBody(rows, { mode: "inline", notes })}</svg>`
    );
}

function renderCapabilityInline(rows) {
    return (
        `<svg class="chart" id="chart-capability" viewBox="0 0 ${WIDTH} ${CAP_HEIGHT}" role="img" ` +
        `aria-labelledby="chart-capability-title chart-capability-desc" preserveAspectRatio="xMidYMid meet">` +
        `<title id="chart-capability-title">${CAP_TITLE}</title>` +
        `<desc id="chart-capability-desc">${capabilityDescription(rows)}</desc>` +
        `${renderCapabilityBody(rows, { mode: "inline" })}</svg>`
    );
}

/**
 * Swap one or more regions of a file, failing loudly when an anchor has moved. Every
 * replacement is applied to the same buffer, so two charts in one page cannot overwrite
 * each other's result.
 */
function spliced(file, replacements) {
    const before = fs.readFileSync(file, "utf8");
    let after = before;
    for (const [pattern, replacement] of replacements) {
        if (!pattern.test(after)) {
            throw new Error(
                `Could not find ${pattern} in ${path.relative(root, file)}. Update the pattern in this script.`,
            );
        }

        after = after.replace(pattern, () => replacement);
    }

    return { file, before, after };
}

/** Render every published copy. Returns the files and their new contents, without writing. */
function renderAll(report) {
    const rows = resolveRows(report.results);
    const capabilities = resolveCapabilityRows(report.results);
    const notes = footnotes(report);
    const media = path.join(root, "site", "media");
    const research = path.join(root, "site", "research", "index.html");
    const files = [
        { file: path.join(media, "context-chart-light.svg"), after: renderStandalone(rows, "light", notes) },
        { file: path.join(media, "context-chart-dark.svg"), after: renderStandalone(rows, "dark", notes) },
        {
            file: path.join(media, "capability-chart-light.svg"),
            after: renderCapabilityStandalone(capabilities, "light"),
        },
        {
            file: path.join(media, "capability-chart-dark.svg"),
            after: renderCapabilityStandalone(capabilities, "dark"),
        },
        spliced(research, [
            [/<svg class="chart" id="chart-context"[\s\S]*?<\/svg>/u, renderInline(rows, notes)],
            [/<svg class="chart" id="chart-capability"[\s\S]*?<\/svg>/u, renderCapabilityInline(capabilities)],
        ]),
        spliced(path.join(root, "README.md"), [
            [/(?<=context-chart-light\.svg" width="880" alt=")[^"]*/u, altText(rows)],
            [/(?<=capability-chart-light\.svg" width="880" alt=")[^"]*/u, capabilityAltText(capabilities)],
        ]),
    ];

    return files.map((entry) => ({
        ...entry,
        before: entry.before ?? (fs.existsSync(entry.file) ? fs.readFileSync(entry.file, "utf8") : null),
    }));
}

/**
 * Write the chart wherever it is published. Returns the relative paths that changed, so a
 * caller can report a no-op run as a no-op.
 */
function writeChart(report) {
    return renderAll(report)
        .filter((entry) => entry.before !== entry.after)
        .map((entry) => {
            fs.writeFileSync(entry.file, entry.after);

            return path.relative(root, entry.file).replace(/\\/gu, "/");
        });
}

/** The relative paths whose published copy has drifted from these numbers. */
function staleChartFiles(report) {
    return renderAll(report)
        .filter((entry) => entry.before !== entry.after)
        .map((entry) => path.relative(root, entry.file).replace(/\\/gu, "/"));
}

export {
    altText,
    capabilityDescription,
    description,
    renderAll,
    resolveCapabilityRows,
    resolveRows,
    staleChartFiles,
    writeChart,
    CAPABILITY_GROUPS,
    ROWS,
};

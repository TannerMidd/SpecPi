#!/usr/bin/env node
// Render the first-call context chart everywhere it is published, from one set of numbers.
//
// The chart appears in three places that must agree: inline in the research page, where it
// picks up the site's theme tokens, and as two standalone SVGs the README references through
// <picture>. GitHub renders a README image as <img>, which loads no external stylesheet and
// no external font, so the standalone pair carries its own palette and embeds the face the
// site links. Keeping one renderer means a measurement moves in one place.
//
// Rows are either measured by scripts/measure-context.mjs or published by HarnessTax (Pan,
// Yang, Arabzadeh, Chiang, Stoica and Zaharia, 16 September 2026, https://harnesstax.github.io/).
// The two are never averaged or silently substituted: a study row carries the study's figure,
// including its Pi bar, which reads 5,420 against our own 5,521 for the same harness. That 2%
// gap is evidence the two measurements are comparable, so the chart keeps the study's number
// for the study's rows and ours for ours.
//
// This module renders; it does not measure. Drive it from scripts/measure-context.mjs, which
// owns the numbers: `node scripts/measure-context.mjs --chart` to write, `--check-chart` to
// verify the published copies still match a fresh run.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Layout. The plot spans AXIS characters across PLOT px starting at LEFT, so a gridline every
// GRID_STEP characters lands on a round number and the widest bar still clears the value label.
const WIDTH = 720;
const HEIGHT = 380;
const LEFT = 108;
const PLOT = 596;
const AXIS = 96000;
const GRID_STEP = 25000;
const BAR_HEIGHT = 22;
const ROW_STEP = 54;
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
const AXIS_LABEL = "Characters on the first model call";

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

// Rows in chart order. `measured` names the configuration label scripts/measure-context.mjs
// prints, so a renamed configuration fails loudly here instead of dropping a bar. `study` rows
// carry HarnessTax's published figures, which this repository does not measure.
const ROWS = [
    { label: "Pi", hue: "pi", study: { tools: "4 tools", toolSchemaChars: 2873, instructionChars: 2547 } },
    { label: "SpecPi", hue: "specpi", measured: "SpecPi first-party" },
    // The "everything on" row is the same harness as the row above it, so it takes the same hue
    // at reduced strength rather than a sixth colour that would imply a sixth product.
    { label: "SpecPi, all on", hue: "specpi", dim: true, measured: "+ specpi-browser-qa" },
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

/** Trim a computed coordinate to sub-pixel precision, so re-rendering is stable. */
function num(value) {
    return String(Number(value.toFixed(3)));
}

/** Characters to px along the shared scale. */
function scale(chars) {
    return PLOT * (chars / AXIS);
}

function group(value) {
    return value.toLocaleString("en-US");
}

/**
 * Resolve the rows against a measurement run. Pass the results array from
 * measure-context.mjs; every `measured` row must be present in it.
 */
function resolveRows(results = []) {
    const byLabel = new Map(results.map((result) => [result.label, result]));

    return ROWS.map((row) => {
        if (row.study) {
            return { ...row, ...row.study };
        }

        const measured = byLabel.get(row.measured);
        if (!measured) {
            throw new Error(
                `The chart needs a measurement for "${row.measured}", which this run did not produce. ` +
                    (row.measured === "Oh My Pi"
                        ? "Pass --omp=<path to its cli.js> to measure it."
                        : "Check the configuration labels in scripts/measure-context.mjs."),
            );
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
 * One chart, as SVG body markup. `mode` is "inline" for the research page, which styles text
 * through site/research.css, or "standalone" for the README pair, which carries its own.
 */
function renderBody(rows, { mode, palette }) {
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

    const lastBarY = FIRST_BAR_Y + (rows.length - 1) * ROW_STEP;
    const gridBottom = lastBarY + BAR_HEIGHT + 4;
    const parts = [];

    // AXIS is not itself a multiple of GRID_STEP: the scale runs slightly past the last
    // gridline so the widest bar's value label has room inside the viewBox.
    for (let value = 0; value <= AXIS; value += GRID_STEP) {
        const x = LEFT + scale(value);
        parts.push(
            `<line x1="${num(x)}" y1="${GRID_TOP}" x2="${num(x)}" y2="${gridBottom}" ` +
                `stroke="${colour("line")}" opacity=".6" />`,
            text(x, gridBottom + 20, "ax", `${value / 1000}k`, { anchor: "middle" }),
        );
    }

    parts.push(text(LEFT + PLOT / 2, gridBottom + 44, "lb", AXIS_LABEL, { anchor: "middle" }));

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
            segment(LEFT, schemaWidth - SEGMENT_GAP, row.dim ? "0.55" : "1", "tool schema", row.toolSchemaChars),
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
        `<rect x="216" y="${LEGEND_Y}" width="11" height="11" rx="2" fill="${colour("muted")}" ` +
            `opacity="${INSTRUCTION_OPACITY}" />`,
        text(233, LEGEND_Y + 10, "ax", "instructions"),
    );

    return parts.join("");
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
        `${figures(rows, "; ")}. Each bar is split into tool schemas and instructions.`
    );
}

/** The README's alt text: the same figures, comma-separated, on one line. */
function altText(rows) {
    return `Bar chart of characters sent on the first model call: ${figures(rows, ", ")}.`;
}

/** A standalone file for the README, carrying its own palette and font. */
function renderStandalone(rows, theme) {
    const font = fs.readFileSync(path.join(root, "site", "fonts", "ibm-plex-sans.woff2")).toString("base64");

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" ` +
        `viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="chart-title chart-desc" ` +
        `font-family="Plex Sans, Arial, Helvetica, sans-serif">\n` +
        `    <title id="chart-title">${TITLE}</title>\n` +
        `    <desc id="chart-desc">${description(rows)}</desc>\n` +
        `    <style>@font-face{font-family:Plex Sans;font-style:normal;font-weight:100 900;` +
        `src:url(data:font/woff2;base64,${font}) format("woff2");}</style>\n` +
        `    ${renderBody(rows, { mode: "standalone", palette: PALETTES[theme] })}\n` +
        `</svg>\n`
    );
}

/** The research page's chart, themed by the page and named for assistive technology. */
function renderInline(rows) {
    return (
        `<svg class="chart" id="chart-context" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" ` +
        `aria-labelledby="chart-context-title chart-context-desc" preserveAspectRatio="xMidYMid meet">` +
        `<title id="chart-context-title">${TITLE}</title>` +
        `<desc id="chart-context-desc">${description(rows)}</desc>` +
        `${renderBody(rows, { mode: "inline" })}</svg>`
    );
}

/** Swap one region of a file, failing loudly when the anchor has moved. */
function spliced(file, pattern, replacement) {
    const before = fs.readFileSync(file, "utf8");
    const matches = before.match(pattern);
    if (!matches) {
        throw new Error(`Could not find the chart in ${path.relative(root, file)}. Update the pattern in this script.`);
    }

    return { file, before, after: before.replace(pattern, () => replacement) };
}

/** Render every published copy. Returns the files and their new contents, without writing. */
function renderAll(results) {
    const rows = resolveRows(results);
    const media = path.join(root, "site", "media");
    const files = [
        { file: path.join(media, "context-chart-light.svg"), after: renderStandalone(rows, "light") },
        { file: path.join(media, "context-chart-dark.svg"), after: renderStandalone(rows, "dark") },
        spliced(
            path.join(root, "site", "research", "index.html"),
            /<svg class="chart" id="chart-context"[\s\S]*?<\/svg>/u,
            renderInline(rows),
        ),
        spliced(path.join(root, "README.md"), /(?<=context-chart-light\.svg" width="880" alt=")[^"]*/u, altText(rows)),
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
function writeChart(results) {
    return renderAll(results)
        .filter((entry) => entry.before !== entry.after)
        .map((entry) => {
            fs.writeFileSync(entry.file, entry.after);

            return path.relative(root, entry.file).replace(/\\/gu, "/");
        });
}

/** The relative paths whose published copy has drifted from these numbers. */
function staleChartFiles(results) {
    return renderAll(results)
        .filter((entry) => entry.before !== entry.after)
        .map((entry) => path.relative(root, entry.file).replace(/\\/gu, "/"));
}

export { altText, description, renderAll, resolveRows, staleChartFiles, writeChart, ROWS };

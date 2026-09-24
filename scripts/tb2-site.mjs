#!/usr/bin/env node
// Publish the Terminal-Bench 2.0 findings to the evaluations page.
//
// This is the whole of that page now. The tier suite that used to fill it was this repository's
// own, and it was retired for the reason it kept reporting: it was built to separate harnesses and
// mostly could not, because nearly everything passed. Terminal-Bench 2.0 is somebody else's
// benchmark with somebody else's tasks, which is the only kind of second opinion a suite cannot
// give itself.
//
// The figures come from site/evaluations/terminal-bench-2.json, which scripts/tb2-metrics.mjs
// derives from the runs. The runs are not in this repository and must not be, because the task
// content carries canary strings.
//
// Usage: node scripts/tb2-metrics.mjs && node scripts/tb2-site.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, hbars, inject, table, thousands } from "./eval-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(root, "site", "evaluations");
const dataFile = path.join(pageDir, "terminal-bench-2.json");
const pageFile = path.join(pageDir, "index.html");
const readmeFile = path.join(root, "README.md");

function niceMax(value, step) {
    return Math.max(step, Math.ceil(value / step) * step);
}

const money = (value) => `$${value.toFixed(4)}`;
const percent = (value) => (value === null ? "not measured" : `${(value * 100).toFixed(1)}%`);

// One band per slice, one bar per harness inside it, so a harness keeps its colour and its position
// across every figure and the eye can carry a row from one chart to the next.
function bySlice(data, { id, title, axisLabel, value, display, step, tick, include = () => true }) {
    const groups = data.slices
        .map((slice) => ({
            label: `Terminal-Bench · ${slice.label} · ${sliceShape(data, slice.id)}`,
            bars: data.harnesses
                .filter((harness) => harness.slices[slice.id] && include(harness.slices[slice.id]))
                .map((harness) => ({
                    label: harness.label,
                    value: value(harness.slices[slice.id]),
                    display: display(harness.slices[slice.id]),
                    colour: harness.colour,
                })),
        }))
        .filter((group) => group.bars.length > 0);
    const swe = sweBand(data, { value, display, include });
    if (swe) {
        groups.push(swe);
    }

    const max = niceMax(Math.max(...groups.flatMap((group) => group.bars.map((bar) => bar.value))), step);

    return hbars({ id, title, axisLabel, groups, max, tick });
}

// SWE-bench as its own band beside the Terminal-Bench ones: same scale, never pooled. Every harness
// gets a row, and one not yet run there shows as TBD rather than disappearing.
function sweBand(data, { value, display, include = () => true }) {
    if (!data.swe) {
        return null;
    }

    const runs = Object.values(data.swe.byHarness).filter(Boolean);
    const perTask = [...new Set(runs.map((run) => Math.round(run.attempts / run.tasks)))].join(" and ");

    return {
        label: `SWE-bench Verified · ${data.swe.tasks} tasks × ${perTask}`,
        bars: data.harnesses
            .filter((harness) => {
                const run = data.swe.byHarness[harness.id];

                return !run || include(run);
            })
            .map((harness) => {
                const run = data.swe.byHarness[harness.id];

                return run
                    ? { label: harness.label, value: value(run), display: display(run), colour: harness.colour }
                    : { label: harness.label, value: 0, display: "TBD", colour: harness.colour };
            }),
    };
}

// "13 tasks × 3" reads as the shape of the work, which is what makes an unequal row obvious rather
// than buried: Oh My Pi ran the widened slice twice, and the band label is where that shows.
function sliceShape(data, sliceId) {
    const runs = data.harnesses.map((harness) => harness.slices[sliceId]).filter(Boolean);
    const tasks = Math.max(...runs.map((run) => run.tasks));
    const attempts = [...new Set(runs.map((run) => Math.round(run.attempts / run.tasks)))].sort((a, b) => a - b);

    // Pooled sittings give each harness a different multiple, so name the per-sitting count instead.
    return attempts.length > 1 ? `${tasks} tasks × ${attempts[0]} per sitting` : `${tasks} tasks × ${attempts[0]}`;
}

function renderCharts(data) {
    const charts = {};

    // Solve rate. The figure the benchmark exists for, and on this evidence the one that separates
    // the arms least: the whole spread is inside the interval any one row carries at this many
    // attempts, which is the point the prose beside it makes.
    charts["chart-solve"] = bySlice(data, {
        id: "chart-solve",
        title: "Solved, per attempt",
        axisLabel: "share of attempts reaching reward 1",
        value: (run) => run.rate,
        display: (run) => `${run.solved}/${run.attempts}`,
        step: 0.25,
        tick: (value) => `${Math.round(value * 100)}%`,
    });

    // Input tokens. This is where the arms actually differ, and by enough that it survives the
    // attempt counts that the solve rates do not.
    charts["chart-tokens"] = bySlice(data, {
        id: "chart-tokens",
        title: "Prompt tokens per attempt",
        axisLabel: "tokens sent, summed over the attempt's model calls",
        value: (run) => run.inputTokens,
        display: (run) => thousands(run.inputTokens),
        step: 250_000,
        tick: (value) => `${Math.round(value / 1000)}k`,
    });

    // Cost, measured slices only. An upper bound and a measurement do not belong on one scale: Claude
    // Code's calibration slice ran before the cache fix, and its bound is seven times the other bars,
    // so plotting it would flatten them into a smear. It is left off rather than drawn as a cost.
    charts["chart-cost"] = bySlice(data, {
        id: "chart-cost",
        title: "Cost per attempt",
        axisLabel: "USD at the frozen price list, for the rows whose cached share was recorded",
        value: (run) => run.cost,
        display: (run) => money(run.cost),
        step: 0.01,
        tick: (value) => `$${value.toFixed(3)}`,
        // Per slice, because the bound is a property of the slice: Claude Code's calibration run
        // predates the cache fix while its widened run does not, and a harness-level test plotted the
        // first as a bar seven times the others.
        include: (run) => !run.costIsUpperBound,
    });

    // Per sitting. The figure the page now turns on: the same harness, the same thirteen tasks, a
    // different hour. Bare Pi's band spans eleven solves, which is wider than any gap this benchmark
    // has measured between two harnesses, and it is the reason nothing here is reported from one run.
    const withSittings = data.harnesses.filter((harness) => (harness.sittings ?? []).length > 1);
    charts["chart-sittings"] = hbars({
        id: "chart-sittings",
        title: "Solve rate, one bar per sitting",
        axisLabel: "widened slice only; each bar is one launch of 39 attempts",
        groups: withSittings.map((harness) => ({
            label: `${harness.label} · ${(harness.spread.low * 100).toFixed(0)}-${(harness.spread.high * 100).toFixed(0)}%`,
            bars: harness.sittings.map((entry) => ({
                label: entry.label,
                value: entry.rate,
                display: `${entry.solved}/${entry.attempts}`,
                colour: harness.colour,
            })),
        })),
        max: 1,
        tick: (value) => `${Math.round(value * 100)}%`,
    });

    // Cache. One bar per harness rather than per slice: the rate barely moves between slices. Claude
    // Code's comes from the attempts whose cached share was recorded, which excludes the 21 Sep runs.
    const cached = data.harnesses.filter((harness) => harness.overall.cacheHitRate !== null);
    charts["chart-cache"] = hbars({
        id: "chart-cache",
        title: "Prompt cache hit rate",
        axisLabel: "cached share of prompt tokens, each benchmark pooled on its own",
        groups: [
            {
                label: "Terminal-Bench",
                bars: cached.map((harness) => ({
                    label: harness.label,
                    value: harness.overall.cacheHitRate,
                    display: percent(harness.overall.cacheHitRate),
                    colour: harness.colour,
                })),
            },
            sweBand(data, {
                value: (run) => run.cacheHitRate ?? 0,
                display: (run) => percent(run.cacheHitRate),
            }),
        ].filter(Boolean),
        max: 1,
        tick: (value) => `${Math.round(value * 100)}%`,
    });

    charts["chart-headtohead"] = renderHeadToHead(data);
    charts["chart-swe"] = renderSwe(data);

    return charts;
}

// A stored pair is (a, b) in harness order. Oriented here so the quoted ratio reads as `numerator`
// against `denominator` whichever way round it was stored.
export function orientedPair(data, numerator, denominator) {
    const pair = data.paired.find(
        (entry) =>
            (entry.a === numerator && entry.b === denominator) || (entry.a === denominator && entry.b === numerator),
    );
    if (!pair) {
        return null;
    }

    const flip = pair.a !== numerator;
    const invert = (summary) =>
        summary && flip
            ? {
                  ...summary,
                  lowerIn: summary.sittings - summary.lowerIn,
                  low: 1 / summary.high,
                  high: 1 / summary.low,
                  typical: 1 / summary.typical,
              }
            : summary;

    return {
        sittings: pair.sittings.map((entry) => ({
            ...entry,
            num: flip ? entry.b : entry.a,
            den: flip ? entry.a : entry.b,
            tokenRatio: flip ? 1 / entry.tokenRatio : entry.tokenRatio,
            costRatio: entry.costRatio === null ? null : flip ? 1 / entry.costRatio : entry.costRatio,
        })),
        tokens: invert(pair.tokens),
        cost: invert(pair.cost),
        solved: flip
            ? {
                  num: pair.solved.b,
                  den: pair.solved.a,
                  attemptsNum: pair.solved.attemptsB,
                  attemptsDen: pair.solved.attemptsA,
                  p: pair.solved.p,
              }
            : {
                  num: pair.solved.a,
                  den: pair.solved.b,
                  attemptsNum: pair.solved.attemptsA,
                  attemptsDen: pair.solved.attemptsB,
                  p: pair.solved.p,
              },
    };
}

// Head to head: SpecPi against bare Pi, in the sittings both ran. One row per measure, each on its
// own scale, with a dot for each harness and the gap between them drawn as the line joining them.
// The right-hand column states the change, so the diagram reads without its caption.
function renderHeadToHead(data) {
    const pair = orientedPair(data, "specpi", "pi");
    const colourOf = (id) => data.harnesses.find((entry) => entry.id === id)?.colour ?? "var(--muted)";
    const piColour = colourOf("pi");
    const specpiColour = colourOf("specpi");
    const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    const sittings = pair?.sittings ?? [];
    const task = (name) => data.gitPair.find((entry) => entry.task === name);
    const rows = [];
    if (pair) {
        rows.push({
            label: "Solved",
            sub: `widened slice · p = ${pair.solved.p.toFixed(2)}`,
            pi: pair.solved.den / pair.solved.attemptsDen,
            specpi: pair.solved.num / pair.solved.attemptsNum,
            max: 1,
            higherIsBetter: true,
            text: [`${pair.solved.den}/${pair.solved.attemptsDen}`, `${pair.solved.num}/${pair.solved.attemptsNum}`],
            kind: "rate",
        });
    }

    for (const name of ["sanitize-git-repo", "fix-git"]) {
        const entry = task(name);
        if (!entry?.byHarness.pi || !entry?.byHarness.specpi) {
            continue;
        }

        const pi = entry.byHarness.pi;
        const specpi = entry.byHarness.specpi;
        rows.push({
            label: name,
            sub: `${specpi.attempts} attempts · p = ${entry.p < 0.01 ? entry.p.toFixed(3) : entry.p.toFixed(2)}`,
            pi: pi.solved / pi.attempts,
            specpi: specpi.solved / specpi.attempts,
            max: 1,
            higherIsBetter: true,
            text: [`${pi.solved}/${pi.attempts}`, `${specpi.solved}/${specpi.attempts}`],
            kind: "rate",
            code: true,
        });
    }

    if (sittings.length > 0) {
        const tokens = [
            mean(sittings.map((entry) => entry.den.inputTokens)),
            mean(sittings.map((entry) => entry.num.inputTokens)),
        ];
        const cost = [mean(sittings.map((entry) => entry.den.cost)), mean(sittings.map((entry) => entry.num.cost))];
        rows.push({
            label: "Prompt tokens",
            sub: "per attempt",
            pi: tokens[0],
            specpi: tokens[1],
            max: Math.max(...tokens) * 1.15,
            higherIsBetter: false,
            text: tokens.map((value) => `${Math.round(value / 1000)}k`),
            kind: "ratio",
        });
        rows.push({
            label: "Cost",
            sub: "per attempt",
            pi: cost[0],
            specpi: cost[1],
            max: Math.max(...cost) * 1.15,
            higherIsBetter: false,
            text: cost.map((value) => money(value)),
            kind: "ratio",
        });
    }

    return drawDumbbell(
        "chart-headtohead",
        "SpecPi against Pi, in the sittings both ran",
        rows,
        piColour,
        specpiColour,
    );
}

/**
 * SWE-bench, the same drawing as the head-to-head: one solve row and the two spend rows.
 */
function renderSwe(data) {
    const swe = data.swe;
    if (!swe) {
        return "";
    }

    const colourOf = (id) => data.harnesses.find((entry) => entry.id === id)?.colour ?? "var(--muted)";
    const pi = swe.byHarness.pi;
    const specpi = swe.byHarness.specpi;
    const spend = (label, key, format) => ({
        label,
        sub: "per attempt",
        pi: pi[key],
        specpi: specpi[key],
        max: Math.max(pi[key], specpi[key]) * 1.15,
        higherIsBetter: false,
        text: [format(pi[key]), format(specpi[key])],
        kind: "ratio",
    });
    const rows = [
        {
            label: "Solved",
            sub: `${swe.tasks} tasks · p = ${swe.p.toFixed(2)}`,
            pi: pi.rate,
            specpi: specpi.rate,
            max: 1,
            higherIsBetter: true,
            text: [`${pi.solved}/${pi.attempts}`, `${specpi.solved}/${specpi.attempts}`],
            kind: "rate",
        },
        spend("Prompt tokens", "inputTokens", (value) => `${Math.round(value / 1000)}k`),
        spend("Cost", "cost", money),
    ];

    return drawDumbbell(
        "chart-swe",
        "SpecPi against Pi on SWE-bench Verified",
        rows,
        colourOf("pi"),
        colourOf("specpi"),
    );
}

function drawDumbbell(id, title, rows, piColour, specpiColour) {
    // Stacked rows: the label and the change share one line, the track runs full width beneath.
    // A narrow drawing keeps its text legible at phone width; the figure is capped on wide screens.
    const width = 480;
    const left = 8;
    const right = width - 8;
    const rowHeight = 66;
    const top = 30;
    const height = top + rows.length * rowHeight;
    const x = (value, max) => left + (Math.max(0, Math.min(value, max)) / max) * (right - left);
    const parts = [
        `<circle cx="6" cy="10" r="6" fill="${piColour}" /><text x="18" y="14" class="ct-lb">Pi (base)</text>`,
        `<circle cx="96" cy="10" r="6" fill="${specpiColour}" /><text x="108" y="14" class="ct-lb">SpecPi</text>`,
        `<text x="${width}" y="14" text-anchor="end" class="ct-lb">SpecPi vs Pi</text>`,
    ];
    rows.forEach((row, index) => {
        const y = top + index * rowHeight + 16;
        const track = y + 30;
        const piX = x(row.pi, row.max);
        const specpiX = x(row.specpi, row.max);
        const change =
            row.kind === "rate" ? Math.round((row.specpi - row.pi) * 100) : Math.round((row.specpi / row.pi - 1) * 100);
        const better = change === 0 ? null : row.higherIsBetter ? change > 0 : change < 0;
        const tone = better === null ? "var(--muted)" : better ? specpiColour : "var(--ct-warn, #b45309)";
        const delta =
            change === 0
                ? "level"
                : `${change > 0 ? "+" : "−"}${Math.abs(change)}${row.kind === "rate" ? " pts" : "%"}`;
        const label = row.code ? `<tspan font-family="var(--mono)">${esc(row.label)}</tspan>` : esc(row.label);
        // Equal values would hide Pi's dot under SpecPi's, so Pi becomes a ring around it.
        const piMark =
            Math.abs(piX - specpiX) < 1
                ? `<circle cx="${piX.toFixed(1)}" cy="${track}" r="10.5" fill="none" stroke="${piColour}" stroke-width="2.5"><title>Pi: ${esc(row.text[0])}</title></circle>`
                : `<circle cx="${piX.toFixed(1)}" cy="${track}" r="7" fill="${piColour}"><title>Pi: ${esc(row.text[0])}</title></circle>`;
        parts.push(
            `<text x="0" y="${y}" class="ct-row">${label}<tspan class="ct-sub" dx="8">${esc(row.sub)}</tspan></text>`,
            `<text x="${width}" y="${y}" text-anchor="end" class="ct-val" style="fill:${tone}">${delta}<tspan class="ct-sub" dx="8">${esc(row.text[0])} → ${esc(row.text[1])}</tspan></text>`,
            `<line x1="${left}" y1="${track}" x2="${right}" y2="${track}" stroke="var(--line)" stroke-width="2" stroke-linecap="round" />`,
            `<line x1="${piX.toFixed(1)}" y1="${track}" x2="${specpiX.toFixed(1)}" y2="${track}" stroke="${tone}" stroke-width="4" stroke-linecap="round" opacity=".55" />`,
            piMark,
            `<circle cx="${specpiX.toFixed(1)}" cy="${track}" r="7" fill="${specpiColour}"><title>SpecPi: ${esc(row.text[1])}</title></circle>`,
        );
    });

    return `<svg class="chart" id="${id}" viewBox="0 0 ${width} ${height}" style="max-width:640px" role="img" preserveAspectRatio="xMidYMid meet" aria-label="${esc(title)}">${parts.join("")}</svg>`;
}

// Task by task as a heatmap: each cell is shaded by its solve rate, so the hard tasks and the
// harness-sensitive ones stand out before any number is read.
// A harness that has not run the benchmark at all gets TBD; one that ran it but not this task, a dash.
function renderTaskHeatmap(data, tasks = data.tasks, ran = null) {
    const header = ["Task", ...data.harnesses.map((harness) => harness.label)]
        .map((cell, index) => `<th${index === 0 ? "" : ' scope="col"'}>${esc(cell)}</th>`)
        .join("");
    const body = tasks
        .map((entry) => {
            const cells = data.harnesses.map((harness) => {
                const run = entry.byHarness[harness.id];
                if (!run) {
                    return ran && !ran.has(harness.id)
                        ? `<td class="hm-empty">TBD</td>`
                        : `<td class="hm-empty">&mdash;</td>`;
                }

                const rate = run.solved / run.attempts;

                return `<td style="--r:${rate.toFixed(2)}" title="${esc(harness.label)}: ${run.solved} of ${run.attempts}">${run.solved}/${run.attempts}</td>`;
            });

            return `<tr><th><code>${esc(entry.task)}</code></th>${cells.join("")}</tr>`;
        })
        .join("");

    return `<table class="heatmap"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderTables(data) {
    const overall = table(
        ["Harness", "Solved", "Rate", "Per-sitting range", "Prompt tok", "Cache hit", "Cost/attempt"],
        data.harnesses.map((harness) => [
            esc(harness.label),
            `${harness.overall.solved}/${harness.overall.attempts}`,
            harness.overall.rate.toFixed(3),
            harness.spread
                ? `${(harness.spread.low * 100).toFixed(0)}&ndash;${(harness.spread.high * 100).toFixed(0)}% (${harness.spread.sittings})`
                : "one sitting",
            thousands(harness.overall.inputTokens),
            percent(harness.overall.cacheHitRate),
            harness.overall.costIsUpperBound ? `${money(harness.overall.cost)} or less` : money(harness.overall.cost),
        ]),
    );

    const tables = { "table-overall": overall, "table-tasks": renderTaskHeatmap(data) };
    if (data.swe) {
        const ran = new Set(Object.keys(data.swe.byHarness).filter((id) => data.swe.byHarness[id]));
        tables["table-swe"] = table(
            ["Harness", "Solved", "Rate", "Prompt tok", "Cache hit", "Cost/attempt"],
            data.harnesses.map((harness) => {
                const run = data.swe.byHarness[harness.id];

                return run
                    ? [
                          esc(harness.label),
                          `${run.solved}/${run.attempts}`,
                          run.rate.toFixed(3),
                          thousands(run.inputTokens),
                          percent(run.cacheHitRate),
                          money(run.cost),
                      ]
                    : [esc(harness.label), "TBD", "TBD", "TBD", "TBD", "TBD"];
            }),
        );
        tables["table-swe-tasks"] = renderTaskHeatmap(data, data.swe.taskList, ran);
    }

    return tables;
}

// The README carries the same headline as the page. Typing it by hand guarantees it drifts, so it
// gets the same marker treatment: one command updates both, or neither. Rows are ordered by cost,
// because the ordering by score is the one this run says not to read.
function renderReadme(data) {
    const rows = [...data.harnesses].sort((a, b) => a.overall.cost - b.overall.cost);
    // Derived, not typed. A hand-written version of this paragraph went stale twice, quoting a p-value
    // a rerun had moved and a cache share that had since been measured.
    const piSpread = data.harnesses.find((entry) => entry.id === "pi").spread;
    const pair = orientedPair(data, "specpi", "pi");
    const sitting = pair.sittings[0];
    const less = (ratio) => `${Math.round((1 - ratio) * 100)}%`;
    const labelOf = (id) => data.harnesses.find((entry) => entry.id === id).label;
    const rateOf = (id) => data.harnesses.find((entry) => entry.id === id).overall.rate;
    const sanitize = data.gitPair.find((entry) => entry.task === "sanitize-git-repo");
    const fixGit = data.gitPair.find((entry) => entry.task === "fix-git");
    const cellOf = (entry, id) => `${entry.byHarness[id].solved}/${entry.byHarness[id].attempts}`;
    // Pooled pairs that clear p < 0.05, leader first. Named rather than left out, but flagged: pooling
    // sets one harness's sittings against another's.
    const pooledSeparated = data.comparisons
        .filter((entry) => entry.p < 0.05)
        .sort((x, y) => x.p - y.p)
        .map((entry) => {
            const [lead, trail] = rateOf(entry.a) >= rateOf(entry.b) ? [entry.a, entry.b] : [entry.b, entry.a];

            return `${labelOf(lead)} leads ${labelOf(trail)} (p = ${entry.p.toFixed(3)})`;
        });
    const pooledNote =
        pooledSeparated.length === 0
            ? ""
            : ` Pooled across sittings, ${pooledSeparated.join(" and ")}, but pooling sets one harness's sittings against another's.`;
    const cell = (harness) => [
        harness.label,
        `${harness.overall.solved}/${harness.overall.attempts}`,
        harness.overall.rate.toFixed(3),
        harness.overall.costIsUpperBound ? `${money(harness.overall.cost)} or less` : money(harness.overall.cost),
        thousands(harness.overall.inputTokens),
        percent(harness.overall.cacheHitRate),
    ];
    const tick = "`";

    return [
        `**${data.totalAttempts + (data.sweAttempts ?? 0)} scored attempts on two benchmarks and ${data.harnesses.length} harnesses**,`,
        `all on ${tick}${data.model}${tick}. SpecPi is the published 0.33.0 release, with the experimental Jev layer off.`,
        "",
        ...(data.swe ? sweReadme(data) : []),
        `Terminal-Bench 2.0, ${data.totalAttempts} attempts across ${data.taskCount} tasks:`,
        "",
        "| Harness | Solved | Rate | Cost/attempt | Prompt tokens | Cache hit |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows.map((harness) => `| ${cell(harness).join(" | ")} |`),
        "",
        `SpecPi and Pi ran side by side in the ${sitting.label} sitting. SpecPi solved ${pair.solved.num}/${pair.solved.attemptsNum}`,
        `against Pi's ${pair.solved.den}/${pair.solved.attemptsDen} (Fisher p = ${pair.solved.p.toFixed(2)}), sending ${less(sitting.tokenRatio)} fewer prompt tokens and costing`,
        `${less(sitting.costRatio)} less per attempt. On ${tick}sanitize-git-repo${tick}, with that sitting's extra attempts, SpecPi solved`,
        `${cellOf(sanitize, "specpi")} against ${cellOf(sanitize, "pi")} (p = ${sanitize.p.toFixed(3)}); ${tick}fix-git${tick} was ${cellOf(fixGit, "specpi")} for both.`,
        "",
        "Overall solve rate is a different matter: one sitting cannot rank harnesses here. Bare Pi, on",
        `unchanged software and the same thirteen tasks, spans ${(piSpread.low * 100).toFixed(0)}-${(piSpread.high * 100).toFixed(0)}% across ${piSpread.sittings} sittings, a wider gap than any`,
        `measured between two harnesses.${pooledNote} Cost is recomputed from recorded tokens against a dated`,
        "price file, never taken from a harness's self-report.",
    ].join("\n");
}

// SWE-bench leads the README, because it is the closer match to everyday work in a code repository.
function sweReadme(data) {
    const swe = data.swe;
    const pi = swe.byHarness.pi;
    const specpi = swe.byHarness.specpi;
    const change = (a, b) => {
        const value = Math.round((a / b - 1) * 100);

        return value === 0 ? "the same" : `${Math.abs(value)}% ${value > 0 ? "more" : "less"}`;
    };

    const pending = data.harnesses.filter((harness) => !swe.byHarness[harness.id]).map((harness) => harness.label);
    const perTask = Math.round(specpi.attempts / specpi.tasks);

    return [
        `SWE-bench Verified, ${swe.tasks} tasks × ${perTask}: SpecPi solved ${specpi.solved}/${specpi.attempts} against Pi's ${pi.solved}/${pi.attempts}`,
        `(p = ${swe.p.toFixed(2)}), with ${change(specpi.inputTokens, pi.inputTokens)} prompt tokens and ${change(specpi.cost, pi.cost)} cost per attempt.`,
        ...(pending.length > 0 ? [`${pending.join(", ")}: to be run.`] : []),
        "",
    ];
}

function main() {
    const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const page = fs.readFileSync(pageFile, "utf8");
    const filled = inject(page, { ...renderCharts(data), ...renderTables(data) });
    fs.writeFileSync(pageFile, filled);

    const readme = fs.readFileSync(readmeFile, "utf8");
    fs.writeFileSync(readmeFile, inject(readme, { "eval-summary": `\n\n${renderReadme(data)}\n\n` }));
    process.stdout.write(
        `Terminal-Bench 2.0: ${data.harnesses.length} harnesses, ${data.totalAttempts} attempts -> ${path.relative(root, pageFile)}\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}

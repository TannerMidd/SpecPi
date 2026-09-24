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
            label: `${slice.label} · ${sliceShape(data, slice.id)}`,
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
    const max = niceMax(Math.max(...groups.flatMap((group) => group.bars.map((bar) => bar.value))), step);

    return hbars({ id, title, axisLabel, groups, max, tick });
}

// "13 tasks × 3" reads as the shape of the work, which is what makes an unequal row obvious rather
// than buried: Oh My Pi ran the widened slice twice, and the band label is where that shows.
function sliceShape(data, sliceId) {
    const runs = data.harnesses.map((harness) => harness.slices[sliceId]).filter(Boolean);
    const tasks = Math.max(...runs.map((run) => run.tasks));
    const attempts = [...new Set(runs.map((run) => Math.round(run.attempts / run.tasks)))].sort((a, b) => a - b);

    return `${tasks} tasks × ${attempts.join(" and ")}`;
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
        axisLabel: "cached share of prompt tokens, both slices pooled",
        groups: [
            {
                bars: cached.map((harness) => ({
                    label: harness.label,
                    value: harness.overall.cacheHitRate,
                    display: percent(harness.overall.cacheHitRate),
                    colour: harness.colour,
                })),
            },
        ],
        max: 1,
        tick: (value) => `${Math.round(value * 100)}%`,
    });

    const release = renderRelease(data);
    charts["chart-release"] = release.chart;
    charts["release-note"] = release.note;
    charts["chart-release-tokens"] = release.tokens;
    charts["chart-release-cost"] = release.cost;
    charts["release-spend-note"] = release.spendNote;

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

// "−30%" for fewer, "+11%" for more: a signed change reads faster than a ratio.
const change = (ratio) => {
    const value = Math.round((ratio - 1) * 100);

    return value === 0 ? "0%" : `${value > 0 ? "+" : "−"}${Math.abs(value)}%`;
};

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

    // Every sitting, as a grid. This is the evidence for the range column above.
    const ids = Object.keys(data.sittingLabels);
    const sittings = table(
        ["Harness", ...ids.map((id) => esc(data.sittingLabels[id]))],
        data.harnesses.map((harness) => [
            esc(harness.label),
            ...ids.map((id) => {
                const entry = (harness.sittings ?? []).find((e) => e.id === id);

                return entry ? `${entry.solved}/${entry.attempts}` : "&mdash;";
            }),
        ]),
    );

    // The widened slice only. The calibration slice is on the page as the reason the widened one
    // exists rather than as a result, and a task breakdown of it would invite reading it as one.
    const tasks = table(
        ["Task", ...data.harnesses.map((harness) => esc(harness.label))],
        data.tasks.map((entry) => [
            `<code>${esc(entry.task)}</code>`,
            ...data.harnesses.map((harness) => {
                const run = entry.byHarness[harness.id];
                if (!run) {
                    return "&mdash;";
                }

                const cell = `${run.solved}/${run.attempts}`;

                return run.solved === 0 ? `<strong>${cell}</strong>` : cell;
            }),
        ]),
    );

    // SpecPi + Jev against bare Pi, sitting by sitting, in only the launches that ran both. The pooled
    // rows above draw on different sittings; this is the comparison that can be attributed.
    const pair = orientedPair(data, "jev", "pi");
    const paired = pair
        ? table(
              ["Sitting", "Pi solved", "SpecPi + Jev solved", "Prompt tokens", "Cost"],
              pair.sittings.map((entry) => [
                  esc(entry.label),
                  `${entry.den.solved}/${entry.den.attempts}`,
                  `${entry.num.solved}/${entry.num.attempts}`,
                  change(entry.tokenRatio),
                  entry.costRatio === null ? "not comparable" : change(entry.costRatio),
              ]),
          )
        : "";

    return {
        "table-overall": overall,
        "table-sittings": sittings,
        "table-paired": paired,
        "table-tasks": tasks,
    };
}

// The 24 Sep release check: plain SpecPi 0.31.0 and 0.33.0 beside Pi in one sitting. One band per
// measure, one bar per arm, and a caption written from the same data, so no figure quoted beside the
// chart can drift from the bars.
function renderRelease(data) {
    const release = data.release;
    if (!release) {
        return { chart: "", note: "", tokens: "", cost: "", spendNote: "" };
    }

    const ids = ["pi", "specpi-031", "specpi"];
    const harnessOf = (id) => data.harnesses.find((entry) => entry.id === id);
    const measures = [
        ["Terminal-Bench · widened slice", release.widened],
        ...release.tasks.map((entry) => [`${entry.task} · widened + git pair`, entry.arms]),
        ...(release.swe ? [[`SWE-bench Verified · ${release.swe.tasks} tasks`, release.swe.arms]] : []),
    ];
    const groupsOf = (value, display) =>
        measures.map(([label, arms]) => ({
            label,
            bars: ids
                .map((id) => [id, arms?.find((entry) => entry.arm === id)])
                .filter(([, run]) => run)
                .map(([id, run]) => ({
                    label: harnessOf(id)?.label ?? id,
                    value: value(run),
                    display: display(run),
                    colour: harnessOf(id)?.colour,
                })),
        }));
    const peak = (value) => Math.max(...measures.flatMap(([, arms]) => (arms ?? []).map(value)));
    const chart = hbars({
        id: "chart-release",
        title: "Solved, per attempt · 24 Sep release check",
        axisLabel: "share of attempts reaching reward 1; one sitting, all three arms side by side",
        groups: groupsOf(
            (run) => run.solved / run.attempts,
            (run) => `${run.solved}/${run.attempts}`,
        ),
        max: 1,
        tick: (value) => `${Math.round(value * 100)}%`,
    });
    // The same bands for spend. Prompt tokens are where a smaller fixed prompt shows first; cost is
    // what reaches the bill, and output tokens are most of it, so the two do not move together.
    const tokens = hbars({
        id: "chart-release-tokens",
        title: "Prompt tokens per attempt · 24 Sep release check",
        axisLabel: "tokens sent, summed over the attempt's model calls, mean per attempt",
        groups: groupsOf(
            (run) => run.inputTokens,
            (run) => thousands(run.inputTokens),
        ),
        // A multiple of 400k, so the four gridlines fall on round hundreds of thousands.
        max: niceMax(
            peak((run) => run.inputTokens),
            400_000,
        ),
        tick: (value) => `${Math.round(value / 1000)}k`,
    });
    const cost = hbars({
        id: "chart-release-cost",
        title: "Cost per attempt · 24 Sep release check",
        axisLabel: "USD at the frozen price list, mean per attempt",
        groups: groupsOf(
            (run) => run.cost,
            (run) => money(run.cost),
        ),
        // A multiple of $0.008, so the four gridlines fall on round thousandths.
        max: niceMax(
            peak((run) => run.cost),
            0.008,
        ),
        tick: (value) => `$${value.toFixed(3)}`,
    });

    // Two decimals round p = 0.003 to "0.00", which reads as certainty.
    const pText = (p) => (p < 0.01 ? p.toFixed(3) : Math.min(p, 1).toFixed(2));
    const sanitize = release.tasks.find((entry) => entry.task === "sanitize-git-repo")?.arms ?? [];
    const pOf = (arms, id) => arms.find((entry) => entry.arm === id)?.p;
    const note =
        sanitize.length === 3
            ? `On <code>sanitize-git-repo</code>, which the 0.33.0 rule against unrequested irreversible steps is about, 0.33.0 separates from 0.31.0 at <i>p</i>&nbsp;=&nbsp;${pText(pOf(sanitize, "specpi-031"))} and from Pi at <i>p</i>&nbsp;=&nbsp;${pText(pOf(sanitize, "pi"))}: every failure there had rewritten Git history, destroying the commit the checker compares against. Nothing else separates (<i>p</i>&nbsp;&ge;&nbsp;${pText(Math.min(...[release.widened, ...(release.swe ? [release.swe.arms] : [])].flatMap((arms) => arms.map((entry) => entry.p)).filter((p) => p !== null)))}), and <code>fix-git</code>, which legitimately uses Git's recovery commands, did not move. One sitting: read the level rows as one more point in section 04's spread.`
            : "";

    const change = (id, key, arms) => {
        const current = arms.find((entry) => entry.arm === "specpi")?.[key];
        const other = arms.find((entry) => entry.arm === id)?.[key];

        return current && other ? Math.round((current / other - 1) * 100) : null;
    };

    const signed = (value) => (value === null ? "n/a" : `${value > 0 ? "+" : "−"}${Math.abs(value)}%`);
    const spendNote = `Against 0.31.0, 0.33.0's prompt tokens per attempt changed by ${measures
        .map(
            ([label, arms]) => `${signed(change("specpi-031", "inputTokens", arms ?? []))} on ${label.split(" · ")[0]}`,
        )
        .join(", ")}, and its cost per attempt by ${measures
        .map(([label, arms]) => `${signed(change("specpi-031", "cost", arms ?? []))} on ${label.split(" · ")[0]}`)
        .join(
            ", ",
        )}. Output tokens are most of the bill at these cache rates, so cost does not track prompt tokens one for one.`;

    return { chart, tokens, cost, note, spendNote };
}

// The README carries the same headline as the page. Typing it by hand guarantees it drifts, so it
// gets the same marker treatment: one command updates both, or neither. Rows are ordered by cost,
// because the ordering by score is the one this run says not to read.
function renderReadme(data) {
    const rows = [...data.harnesses].sort((a, b) => a.overall.cost - b.overall.cost);
    // Derived, not typed. The sentence below already went stale once, quoting p = 0.83 from a run
    // that a rerun moved to 0.40, and claiming Claude Code's cache was unmeasured after it was.
    const pValue = data.comparisons.find(
        (entry) => [entry.a, entry.b].includes("pi") && [entry.a, entry.b].includes("jev"),
    ).p;
    const piSpread = data.harnesses.find((entry) => entry.id === "pi").spread;
    const pair = orientedPair(data, "jev", "pi");
    const pct = (ratio) => `${Math.round(Math.abs(1 - ratio) * 100)}%`;
    // The range quoted as "fewer" is taken from the sittings where it was fewer. Across all of them it
    // printed "27-30% fewer" once a sitting went the other way, which is neither.
    const ratios = pair.sittings.map((entry) => entry.tokenRatio);
    const lower = ratios.filter((ratio) => ratio < 1);
    const higher = ratios.filter((ratio) => ratio >= 1);
    const tokenRange = `${pct(Math.max(...lower)).slice(0, -1)}–${pct(Math.min(...lower))} fewer`;
    const tokenException =
        higher.length === 0
            ? ""
            : higher.length === 1
              ? `, ${pct(higher[0])} more in the other`
              : `, ${pct(Math.min(...higher)).slice(0, -1)}–${pct(Math.max(...higher))} more in the others`;
    // The pair nearest to separating, named rather than asserted, and paired rather than pooled. Pooled,
    // Pi against Oh My Pi looks closest at p = 0.15; paired, in the one sitting both ran, it is p = 1.00,
    // because the pooled gap was Pi's weak sittings rather than anything Oh My Pi did.
    const labelOf = (id) => data.harnesses.find((entry) => entry.id === id).label;
    const closest = [...data.paired].sort((x, y) => x.solved.p - y.solved.p)[0];
    // Pooled pairs that clear p < 0.05, leader first. Named rather than left out, because "pooled or
    // paired" stopped being true once a one-sitting harness joined rows pooled over six.
    const rateOf = (id) => data.harnesses.find((entry) => entry.id === id).overall.rate;
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

    return [
        `**${data.totalAttempts} scored attempts across ${data.taskCount} tasks and ${data.harnesses.length} harness rows (two SpecPi releases among them)**,`,
        `all on \`${data.model}\`.`,
        "",
        "| Harness | Solved | Rate | Cost/attempt | Prompt tokens | Cache hit |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows.map((harness) => `| ${cell(harness).join(" | ")} |`),
        "",
        `Solve rate does not separate them in the sittings where both ran: Pi against SpecPi + Jev is Fisher p = ${pValue.toFixed(2)}`,
        `pooled and ${pair.solved.p.toFixed(2)} paired, and the closest paired comparison of any two harnesses is`,
        `${labelOf(closest.a)} against ${labelOf(closest.b)} at p = ${closest.solved.p.toFixed(2)}. Nor can it at this`,
        "sample size -- bare Pi, on unchanged software and the same thirteen tasks, spans",
        `${(piSpread.low * 100).toFixed(0)}-${(piSpread.high * 100).toFixed(0)}% across ${piSpread.sittings} separate sittings, a wider gap than any measured here between two`,
        `harnesses.${pooledNote}`,
        "",
        "The rows pool different sittings, so compare them paired. In the sittings where both ran,",
        `SpecPi + Jev sent fewer prompt tokens than Pi in ${pair.tokens.lowerIn} of ${pair.tokens.sittings} (${tokenRange}${tokenException}),`,
        `and cost less in ${pair.cost.lowerIn} of ${pair.cost.sittings}, by about ${pct(pair.cost.typical)}: output tokens are most of the bill.`,
        "Cost is recomputed from recorded tokens against a dated price file, never taken from a",
        "harness's self-report, and SpecPi + Jev's excludes the Jev advisor's own calls.",
    ].join("\n");
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

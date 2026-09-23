#!/usr/bin/env node
// Render the six Jev system flow diagrams into the Jev page, from one description of each flow.
//
// They are published inline, in the page's own `.diagram` vocabulary, rather than as a media pair.
// The site owns a theme toggle and an <img> loads no stylesheet, so a standalone pair would need a
// copy per theme and its own embedded font. Inline, one copy answers both themes from the page's
// tokens and sets its text in the page's face. The palette lives in `site/research.css`.
//
// Width is what shaped the layout. `.wiki-content` caps the column at 56rem and the page's existing
// diagrams are drawn at 720, so these are too: any wider and the labels arrive at a scale they do
// not survive.
//
// Each figure carries the flow and the one measurement that justifies it. It carries no title and
// no footnotes, because the list item above it names the system and section 09 reports the results.
//
// Run: node scripts/jev-diagrams.mjs [--check]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(root, "site", "jev", "index.html");

const W = 720;
const EDGE = 8;
const COL = { x: 8, w: 380, cx: 198 };
const RAIL = { x: 420, w: 292, cx: 566 };
const GAP = 26;
const TITLE_BASE = 19;
const NOTE_TOP = 40;
const NOTE_ONLY = 22;
const NOTE_STEP = 16;

const MDASH = "&#8212;";
const DOT = "&#183;";
const APPROX = "&#8776;";
const MINUS = "&#8722;";
const GE = "&#8805;";
const LDQ = "&#8220;";
const RDQ = "&#8221;";
const ELL = "&#8230;";

function text(x, y, body, { cls = "dg-note", anchor = "middle" } = {}) {
    return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${body}</text>`;
}

function label(y, body) {
    return text(EDGE, y, body, { cls: "dg-tag", anchor: "start" });
}

/** The height a box needs for its own contents, so no line can fall outside one. */
function heightOf({ title, lines = [], kind = "dg-box" }) {
    const inner = lines.length === 0 ? 30 : (title ? NOTE_TOP : NOTE_ONLY) + (lines.length - 1) * NOTE_STEP + 12;

    return inner + (kind === "dg-dec" ? 12 : 0);
}

function box(x, y, w, spec) {
    const { title, lines = [], kind = "dg-box", center = false } = spec;
    const h = spec.h ?? heightOf(spec);
    const cx = x + w / 2;
    const parts = [];
    if (kind === "dg-dec") {
        parts.push(
            `<polygon class="dg-dec" points="${x + 20},${y} ${x + w - 20},${y} ${x + w},${y + h / 2} ${x + w - 20},${y + h} ${x + 20},${y + h} ${x},${y + h / 2}"/>`,
        );
    } else {
        parts.push(`<rect class="${kind}" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>`);
    }

    const block = (title ? 20 : 0) + lines.length * NOTE_STEP;
    let cursor = center ? y + (h - block) / 2 + 13 : y + (title ? TITLE_BASE : NOTE_ONLY);
    if (title) {
        parts.push(text(cx, cursor, title, { cls: "dg-title" }));
        cursor += center ? 20 : NOTE_TOP - TITLE_BASE;
    }

    for (const [index, item] of lines.entries()) {
        const entry = typeof item === "string" ? { s: item } : item;
        parts.push(text(cx, cursor + index * NOTE_STEP, entry.s, { cls: entry.cls ?? "dg-note" }));
    }

    return parts.join("");
}

function arrow(x, y1, y2, { cls = "dg-flow", tag } = {}) {
    const head = cls === "dg-flow-accent" ? "arrow-a" : "arrow";
    const parts = [`<line class="${cls}" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" marker-end="url(#${head})"/>`];
    if (tag) {
        parts.push(text(x + 9, (y1 + y2) / 2 + 4, tag, { cls: "dg-edge", anchor: "start" }));
    }

    return parts.join("");
}

/** Lay the column out on one rhythm and report where each step landed. */
function flow(startY, steps) {
    const parts = [];
    const at = [];
    let y = startY;
    steps.forEach((step, index) => {
        const h = heightOf(step);
        parts.push(box(COL.x, y, COL.w, step));
        at.push({ top: y, bottom: y + h, mid: Math.round(y + h / 2) });
        y += h;
        if (index < steps.length - 1) {
            parts.push(arrow(COL.cx, y, y + GAP, { cls: step.out ?? "dg-flow", tag: step.outTag }));
            y += GAP;
        }
    });

    return { svg: parts.join(""), bottom: y, at };
}

/** A declined branch, leaving the column for the rail on the level it left at. */
function decline(y) {
    return (
        `<line class="dg-flow" x1="${COL.x + COL.w}" y1="${y}" x2="${RAIL.x - 5}" y2="${y}" marker-end="url(#arrow)"/>` +
        text((COL.x + COL.w + RAIL.x) / 2, y - 7, "no", { cls: "dg-edge" })
    );
}

/**
 * The rail every declined branch lands in, spanning the levels that reach it so each one can
 * arrive on a straight line rather than through a lane of its own.
 */
function rail(from, to, spec) {
    const top = from - 34;

    return { svg: box(RAIL.x, top, RAIL.w, { ...spec, h: to - top + 34, center: true }), bottom: to + 34 };
}

function pill(hook) {
    return (
        `<rect class="dg-pill" x="${W - EDGE - 196}" y="4" width="196" height="21" rx="10"/>` +
        text(W - EDGE - 98, 19, `fires on: ${hook}`, { cls: "dg-pill-text" })
    );
}

function figure(id, height, description, content) {
    return (
        `<svg class="diagram" id="flow-${id}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${description}">` +
        `<defs>` +
        `<marker id="fh-${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" class="dg-head"/></marker>` +
        `<marker id="fa-${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" class="dg-head-accent"/></marker>` +
        `</defs>` +
        content.replaceAll("url(#arrow)", `url(#fh-${id})`).replaceAll("url(#arrow-a)", `url(#fa-${id})`) +
        `</svg>`
    );
}

// ------------------------------------------------------------------ 1. retention

function retention() {
    const f = flow(38, [
        {
            title: "A read-only tool returns output",
            lines: [
                { s: `grep ${DOT} find ${DOT} ls ${DOT} web_search`, cls: "dg-mono" },
                { s: `fetch_content ${DOT} browser_snapshot ${DOT} delegate`, cls: "dg-mono" },
            ],
        },
        {
            kind: "dg-dec",
            title: "Worth asking about?",
            lines: [`observing tool, not read ${DOT} at least 4 KB ${DOT} not an error`],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            title: "Two decision questions in one call",
            lines: [
                "How much will the rest of the task still need this?",
                { s: "Spent&#160;/&#160;Background&#160;/&#160;Load-bearing", cls: "dg-mono" },
                "Does it hold the fact the task was looking for?",
            ],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            kind: "dg-dec",
            title: "Confidently spent, and not the answer?",
            lines: [
                `Score confidence ${GE} 0.60 ${DOT} spent value &#8804; 0.20`,
                "answer Noul &#8804; 0.10; valid answers required",
            ],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            kind: "dg-box-accent",
            title: "Code replaces the body with a digest",
            lines: [
                { s: "first 12 lines + notice + optional last 4", cls: "dg-mono" },
                "only applied when the replacement saves bytes;",
                "no model-written prose enters the transcript",
            ],
        },
    ]);

    const side = rail(f.at[1].mid, f.at[3].mid, {
        title: "Appended whole",
        lines: [
            "Any doubt keeps the result intact:",
            "carrying a result costs tokens, but",
            "dropping the wrong one costs the task.",
        ],
    });
    const bar = f.bottom + 30;
    const p2 = bar + 46 + 40;
    const blocks = (y, kinds) =>
        kinds
            .map((kind, i) => `<rect class="dg-blk ${kind}" x="${8 + i * 58}" y="${y}" width="50" height="28" rx="4"/>`)
            .join("");

    const content =
        pill("tool_result") +
        label(19, "WHEN A RESULT ARRIVES") +
        f.svg +
        arrow(COL.cx, f.bottom, bar - 4, { cls: "dg-flow-accent" }) +
        side.svg +
        decline(f.at[1].mid) +
        decline(f.at[3].mid) +
        arrow(RAIL.cx, side.bottom, bar - 4) +
        box(EDGE, bar, W - EDGE * 2, {
            h: 46,
            kind: "dg-bar",
            title: `Appended to the transcript ${MDASH} the prefix every later turn is billed against`,
            lines: ["re-read the source if needed; the original result is not archived"],
        }) +
        label(p2, "SIMULATED SAVINGS OVER RECORDED TOKEN HISTORY") +
        text(EDGE, p2 + 28, `On arrival ${MDASH} the digest is written at the tip`, {
            cls: "dg-title",
            anchor: "start",
        }) +
        blocks(p2 + 38, ["", "", "", "", "", "", "", "", "dg-blk-on"]) +
        `<line class="dg-span" x1="8" y1="${p2 + 74}" x2="464" y2="${p2 + 74}"/>` +
        text(236, p2 + 90, `cached prefix ${MDASH} never touched, still a cache hit`) +
        `<line class="dg-span-accent" x1="472" y1="${p2 + 74}" x2="522" y2="${p2 + 74}"/>` +
        text(497, p2 + 90, "digest", { cls: "dg-note dg-accent" }) +
        text(540, p2 + 54, `${APPROX} ${MINUS}61%`, { cls: "dg-stat dg-accent", anchor: "start" }) +
        text(540, p2 + 70, "modelled, not live", { anchor: "start" }) +
        text(EDGE, p2 + 128, `Retroactive ${MDASH} an older result condensed later`, {
            cls: "dg-title",
            anchor: "start",
        }) +
        blocks(p2 + 138, [
            "",
            "",
            "dg-blk-warn",
            "dg-blk-gone",
            "dg-blk-gone",
            "dg-blk-gone",
            "dg-blk-gone",
            "dg-blk-gone",
            "dg-blk-gone",
        ]) +
        `<line class="dg-span" x1="8" y1="${p2 + 174}" x2="116" y2="${p2 + 174}"/>` +
        text(62, p2 + 190, "still cached") +
        `<line class="dg-span-warn" x1="124" y1="${p2 + 174}" x2="174" y2="${p2 + 174}"/>` +
        text(149, p2 + 190, "rewritten", { cls: "dg-note dg-warn" }) +
        `<line class="dg-span-warn" x1="182" y1="${p2 + 174}" x2="522" y2="${p2 + 174}"/>` +
        text(352, p2 + 190, "everything after the edit is re-billed", { cls: "dg-note dg-warn" }) +
        text(540, p2 + 154, `${APPROX} ${MINUS}12%`, { cls: "dg-stat dg-warn", anchor: "start" }) +
        text(540, p2 + 170, "same simulation", { anchor: "start" });

    return figure(
        "retention",
        p2 + 206,
        "A large listing, search or fetched result is judged as it arrives; file reads and shell output are never asked about. Unless Jev is confident the result is spent and does not hold the answer, it is appended whole; when both answers clear the gate, code replaces the body with a fixed head-and-tail digest. Simulation over recorded token history estimates 61 percent lower cost on arrival versus 12 percent for a later rewrite; these are not observed advisor savings or task-quality results.",
        content,
    );
}

// ------------------------------------------------------------------ 2. gap

function gap() {
    const f = flow(38, [
        {
            title: "The improvement loop files a gap report",
            lines: [
                { s: `capability ${DOT} scenario ${DOT} limitation ${DOT} workaround`, cls: "dg-mono" },
                "a redacted account of something the harness could not do",
            ],
        },
        {
            title: "Local state first",
            lines: ["shortlist at most four known problems by token overlap"],
        },
        {
            title: "One call, six questions",
            lines: [
                "Which known problem is this the same problem as?",
                "How badly did the limitation obstruct the task?",
                { s: "What would fix it? tool / skill / prompt / config", cls: "dg-mono" },
                "Does it carry a secret? Does it name a person or machine?",
                "Was this a one-off, or a mistake in how it was asked?",
            ],
        },
    ]);

    const fan = f.bottom + 42;
    const tags = fan + 50;
    const tagW = 168;
    const tagX = (i) => 8 + i * 178;
    const tag = (i, title, note, kind = "dg-box") =>
        `<rect class="${kind}" x="${tagX(i)}" y="${tags}" width="${tagW}" height="54" rx="7"/>` +
        text(tagX(i) + tagW / 2, tags + 22, title, { cls: "dg-title" }) +
        text(tagX(i) + tagW / 2, tags + 40, note);
    const leg = (i, cls) =>
        `<line class="${cls}" x1="${tagX(i) + tagW / 2}" y1="${fan + 14}" x2="${tagX(i) + tagW / 2}" y2="${tags - 5}" marker-end="url(#arrow)"/>`;
    const bar = tags + 54 + 44;
    const p2 = bar + 46 + 40;
    const step = (x, title, note, kind = "dg-box") =>
        `<rect class="${kind}" x="${x}" y="${p2 + 24}" width="212" height="54" rx="7"/>` +
        text(x + 106, p2 + 46, title, { cls: "dg-title" }) +
        text(x + 106, p2 + 64, note);

    const content =
        pill("specpi:gap-triage") +
        label(19, "WHEN A GAP REPORT ARRIVES") +
        f.svg +
        arrow(COL.cx, f.bottom, fan - 22) +
        text(COL.cx, fan + 2, "six answers, four of them advisory", { cls: "dg-title" }) +
        `<line class="dg-flow" x1="${tagX(0) + tagW / 2}" y1="${fan + 14}" x2="${tagX(2) + tagW / 2}" y2="${fan + 14}"/>` +
        `<line class="dg-flow-warn" x1="${tagX(2) + tagW / 2}" y1="${fan + 14}" x2="${tagX(3) + tagW / 2}" y2="${fan + 14}"/>` +
        leg(0, "dg-flow") +
        leg(1, "dg-flow") +
        leg(2, "dg-flow") +
        leg(3, "dg-flow-warn") +
        tag(0, "merge suggestion", "a problem it may match") +
        tag(1, "impact and fix kind", "a second opinion") +
        tag(2, "a one-off, not a gap", "advisory flag only") +
        tag(3, "sanitize first", "this one holds the write", "dg-box-warn") +
        text(tagX(3) + tagW / 2, tags + 70, "0.87–0.98 written, ≤ 0.07 mentioned", { cls: "dg-note dg-warn" }) +
        box(EDGE, bar, W - EDGE * 2, {
            h: 46,
            kind: "dg-bar",
            title: "Attached to the report as suggestions",
            lines: ["canonical keys, cluster membership and selection authority stay where they were"],
        }) +
        label(p2, "WHAT IT CANNOT DO") +
        step(8, "Jev", "suggests") +
        step(254, "the report", "a lead, not authorization") +
        step(500, "a human at /harness-improvement", "selects, exactly", "dg-box-accent") +
        `<line class="dg-flow" x1="220" y1="${p2 + 51}" x2="249" y2="${p2 + 51}" marker-end="url(#arrow)"/>` +
        `<line class="dg-flow" x1="466" y1="${p2 + 51}" x2="495" y2="${p2 + 51}" marker-end="url(#arrow)"/>` +
        `<path class="dg-flow-stop-warn" d="M 114 ${p2 + 84} C 114 ${p2 + 116} 606 ${p2 + 116} 606 ${p2 + 84}"/>` +
        `<line class="dg-strike" x1="346" y1="${p2 + 96}" x2="374" y2="${p2 + 118}"/>` +
        `<line class="dg-strike" x1="374" y1="${p2 + 96}" x2="346" y2="${p2 + 118}"/>` +
        text(360, p2 + 140, "no path from an observation to a change", { cls: "dg-note dg-warn" });

    return figure(
        "gap",
        p2 + 160,
        "A gap report filed by the improvement loop is compared against a locally shortlisted set of known problems. Six questions produce a merge suggestion, an impact opinion, a fix kind and a one-off flag, all advisory, plus two sanitization flags -- a secret value, or a named person or machine -- either of which holds the write. Nothing here moves a canonical key: only an exact human selection authorizes a change.",
        content,
    );
}

// ------------------------------------------------------------------ 3. sources

function sources() {
    const f = flow(38, [
        {
            title: "A delegation batch is about to run",
            lines: [
                { s: "delegate(run), a job with two or more sources", cls: "dg-mono" },
                "the child is read-only, and the set is already chosen",
            ],
        },
        {
            kind: "dg-dec",
            title: "Small enough to be worth asking about?",
            lines: ["at most 40 candidates, and a 1 KiB evidence budget"],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            title: "One call",
            lines: [
                "How likely is each candidate to hold the answer?",
                { s: "Unrelated&#160;/&#160;Possibly relevant&#160;/&#160;Very likely", cls: "dg-mono" },
                "and: can a read-only child answer this at all?",
            ],
            out: "dg-flow-accent",
            outTag: "yes",
        },
    ]);

    const side = rail(f.at[1].mid, f.at[1].mid + 42, {
        title: "Order untouched",
        lines: [
            "Paths are state, not instructions.",
            "A job too large to judge leaves the",
            "order exactly as the caller wrote it.",
        ],
    });
    const p2 = Math.max(f.bottom, side.bottom) + 40;
    const rowY = (i) => p2 + 92 + i * 46;
    const slot = (x, i, kind, name, note) =>
        `<rect class="dg-blk ${kind}" x="${x}" y="${rowY(i)}" width="250" height="34" rx="5"/>` +
        text(x + 12, rowY(i) + 22, name, { cls: "dg-mono dg-strong", anchor: "start" }) +
        text(x + 238, rowY(i) + 22, note, { anchor: "end" });
    const link = (from, to, cls) =>
        `<path class="${cls}" d="M 264 ${rowY(from) + 17} C 340 ${rowY(from) + 17} 380 ${rowY(to) + 17} 452 ${rowY(to) + 17}" marker-end="url(#arrow${cls === "dg-flow-accent" ? "-a" : ""})"/>`;
    const bar = rowY(4) + 34 + 44;

    const content =
        pill("tool_call") +
        label(19, "WHEN A DELEGATION BATCH IS ABOUT TO RUN") +
        f.svg +
        side.svg +
        decline(f.at[1].mid) +
        label(p2, "WHAT REORDERING ACTUALLY MEANS") +
        text(EDGE, p2 + 28, "Only gated slots move, and only among themselves", {
            cls: "dg-title",
            anchor: "start",
        }) +
        text(
            EDGE,
            p2 + 46,
            "A candidate whose score never cleared the gate is not ranked low. It is not ranked at all,",
            {
                anchor: "start",
            },
        ) +
        text(EDGE, p2 + 60, "so it keeps the position the caller gave it.", { anchor: "start" }) +
        text(133, rowY(0) - 8, "BEFORE", { cls: "dg-tag" }) +
        text(577, rowY(0) - 8, "AFTER", { cls: "dg-tag" }) +
        slot(8, 0, "dg-blk-on", "docs/browser-testing.md", "very likely") +
        slot(8, 1, "", "templates/settings.json", "no answer") +
        slot(8, 2, "dg-blk-on", "site/index.html", "unrelated") +
        slot(8, 3, "dg-blk-on", "scripts/lib.mjs", "possibly") +
        slot(8, 4, "", "THIRD_PARTY.md", "no answer") +
        slot(462, 0, "dg-blk-on", "docs/browser-testing.md", "1st") +
        slot(462, 1, "dg-blk-pinned", "templates/settings.json", "unmoved") +
        slot(462, 2, "dg-blk-on", "scripts/lib.mjs", "2nd") +
        slot(462, 3, "dg-blk-on", "site/index.html", "3rd") +
        slot(462, 4, "dg-blk-pinned", "THIRD_PARTY.md", "unmoved") +
        link(0, 0, "dg-flow-accent") +
        link(2, 3, "dg-flow-accent") +
        link(3, 2, "dg-flow-accent") +
        link(1, 1, "dg-flow-stop") +
        link(4, 4, "dg-flow-stop") +
        text(360, rowY(4) + 56, "the two ungated candidates keep positions 2 and 5") +
        box(EDGE, bar, W - EDGE * 2, {
            h: 46,
            kind: "dg-bar",
            title: "The same set is frozen either way",
            lines: ["ordering only: the child simply pages through list_sources in this order"],
        });

    return figure(
        "sources",
        bar + 62,
        "Before a delegation batch runs, each candidate source is scored for how likely it is to hold the answer. Only slots whose score cleared the gate are reordered, and only among themselves: an ungated candidate keeps the position the caller gave it. The same set is frozen either way, so this changes the order a child reads in and nothing else.",
        content,
    );
}

// ------------------------------------------------------------------ 4. untrusted

function untrusted() {
    const f = flow(38, [
        {
            title: "Content arrives from outside this machine",
            lines: [
                { s: `web_search ${DOT} fetch_content ${DOT} source_check`, cls: "dg-mono" },
                { s: `browser_snapshot ${DOT} browser_accessibility`, cls: "dg-mono" },
                { s: `a shell fetch: curl ${DOT} wget ${DOT} gh api ${DOT} Invoke-WebRequest`, cls: "dg-mono" },
            ],
        },
        {
            kind: "dg-dec",
            title: "Did it come from outside?",
            lines: ["other shell output, file reads and searches are not"],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            title: "One question",
            lines: ["Is this content addressed to an AI agent reading it,", "rather than written for a human reader?"],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            kind: "dg-dec",
            title: "Confident yes?",
            lines: [`Noul ${GE} 0.85 ${MDASH} 0.97 on an injected page, 0.04 on prose`],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            kind: "dg-box-accent",
            title: "Code prepends one fixed line",
            lines: [
                { s: `${LDQ}[SpecPi: the content below was fetched${ELL}${RDQ}`, cls: "dg-mono" },
                "Idempotent, and a plain prefix test: content that",
                "quotes the banner cannot suppress a real one.",
            ],
        },
    ]);

    const side = rail(f.at[1].mid, f.at[3].mid, {
        title: "Nothing changes",
        lines: [
            "Fail-silent by design. A banner on",
            "ordinary prose is the false positive",
            "that teaches a model to stop reading",
            "the channel, so the middle band",
            "does nothing at all.",
        ],
    });
    const bar = f.bottom + 30;
    const p2 = bar + 46 + 40;

    const content =
        pill("tool_result") +
        label(19, "WHEN EXTERNAL CONTENT ARRIVES") +
        f.svg +
        arrow(COL.cx, f.bottom, bar - 4, { cls: "dg-flow-accent" }) +
        side.svg +
        decline(f.at[1].mid) +
        decline(f.at[3].mid) +
        arrow(RAIL.cx, side.bottom, bar - 4) +
        box(EDGE, bar, W - EDGE * 2, {
            h: 46,
            kind: "dg-bar",
            title: "The result is appended, banner first",
            lines: ["the warning never blocks; retention may independently shorten the result"],
        }) +
        label(p2, "SHARES A CALL WHEN THE RESULT ALSO QUALIFIES FOR RETENTION") +
        box(8, p2 + 20, 200, { h: 52, title: "retention asks", lines: ["is this still needed?"] }) +
        box(8, p2 + 84, 200, { h: 52, title: "untrusted asks", lines: ["is it for the agent?"] }) +
        `<polyline class="dg-flow-accent" points="208,${p2 + 46} 234,${p2 + 46} 234,${p2 + 78} 258,${p2 + 78}" marker-end="url(#arrow-a)"/>` +
        `<polyline class="dg-flow-accent" points="208,${p2 + 110} 234,${p2 + 110} 234,${p2 + 78} 258,${p2 + 78}" marker-end="url(#arrow-a)"/>` +
        box(262, p2 + 52, 200, {
            h: 52,
            kind: "dg-box-accent",
            title: "One call",
            lines: [{ s: `${APPROX} 300 ms ${DOT} $0.0000105`, cls: "dg-mono" }],
        }) +
        text(480, p2 + 62, "Both questions are evaluated", { anchor: "start" }) +
        text(480, p2 + 78, "against one state, and the digest", { anchor: "start" }) +
        text(480, p2 + 94, "retention already samples is the", { anchor: "start" }) +
        text(480, p2 + 110, "digest this one needs.", { anchor: "start" });

    return figure(
        "untrusted",
        p2 + 156,
        "Content fetched from outside the machine is checked once for whether it is addressed to an agent rather than to a human reader. A confident yes prepends one fixed banner line written by code; anything else changes nothing. It never blocks. When the same result also qualifies for retention, both questions share one request against the same sample.",
        content,
    );
}

// ------------------------------------------------------------------ 5. capability

function capability() {
    const f = flow(38, [
        {
            title: "Before an agent request, at most once per session",
            lines: ["a tool group the human has withdrawn is available", { s: `web ${DOT} browser`, cls: "dg-mono" }],
        },
        {
            kind: "dg-dec",
            title: "Does local state make the question worth asking?",
            lines: [
                "the request mentions a page, a URL, rendering or CSS,",
                "or one bounded readdir finds web assets here",
            ],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            title: "One call, before this agent request is sent",
            lines: [
                "Will it need the web? A browser?",
                "Would a large read over many files answer it better?",
                "the request is bounded to 400 characters",
            ],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            kind: "dg-dec",
            title: "Confident yes?",
            lines: [`Noul ${GE} 0.85 ${MDASH} 0.86 on a request that needs a browser`],
            out: "dg-flow-accent",
            outTag: "yes",
        },
        {
            kind: "dg-box-accent",
            title: "It offers a separate human confirmation",
            lines: [
                { s: "delegation is a suggestion to run /delegate on", cls: "dg-mono" },
                "the human still decides, a decline is remembered,",
                "and with nobody at the keyboard it proposes nothing",
            ],
        },
    ]);

    const side = rail(f.at[1].mid, f.at[3].mid, {
        title: "Nothing is proposed",
        lines: [
            "Deliberately asymmetric. A false",
            "positive costs the group's schema on",
            "every later request. A false negative",
            "costs nothing: request_capability",
            "is still there.",
        ],
    });
    const bar = f.bottom + 30;
    const p2 = bar + 46 + 40;
    const turns = (y, kinds) =>
        kinds
            .map(
                (kind, i) =>
                    `<rect class="dg-blk ${kind}" x="${8 + i * 53}" y="${y}" width="45" height="26" rx="4"/>` +
                    text(30 + i * 53, y + 17, String(i + 1), { cls: "dg-turn" }),
            )
            .join("");

    const content =
        pill("before_agent_start") +
        label(19, "FIRST ENABLED, INTERACTIVE OPPORTUNITY") +
        f.svg +
        arrow(COL.cx, f.bottom, bar - 4, { cls: "dg-flow-accent" }) +
        side.svg +
        decline(f.at[1].mid) +
        decline(f.at[3].mid) +
        arrow(RAIL.cx, side.bottom, bar - 4) +
        box(EDGE, bar, W - EDGE * 2, {
            h: 46,
            kind: "dg-bar",
            title: "The human makes the same decision they would have made",
            lines: ["the only thing this system changes is when they are asked"],
        }) +
        label(p2, "WHY MOVING THE DECISION EARLIER IS THE WHOLE POINT") +
        text(EDGE, p2 + 28, "armed at turn 1", { cls: "dg-title", anchor: "start" }) +
        turns(p2 + 36, [
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
            "dg-blk-on",
        ]) +
        text(548, p2 + 46, "+16%", { cls: "dg-stat dg-accent", anchor: "start" }) +
        text(548, p2 + 62, "one warm cache", { anchor: "start" }) +
        text(EDGE, p2 + 98, "flipped on at turn 6", { cls: "dg-title", anchor: "start" }) +
        turns(p2 + 106, [
            "",
            "",
            "",
            "",
            "",
            "dg-blk-warn",
            "dg-blk-gone",
            "dg-blk-gone",
            "dg-blk-gone",
            "dg-blk-gone",
        ]) +
        `<line class="dg-break" x1="${8 + 5 * 53 - 4}" y1="${p2 + 100}" x2="${8 + 5 * 53 - 4}" y2="${p2 + 138}"/>` +
        text(EDGE, p2 + 156, "cached tokens collapse to 3,200 while the prompt keeps climbing, and the re-warm", {
            cls: "dg-note dg-warn",
            anchor: "start",
        }) +
        text(EDGE, p2 + 172, "costs 20% of the attempt", { cls: "dg-note dg-warn", anchor: "start" }) +
        text(548, p2 + 116, "+47%", { cls: "dg-stat dg-warn", anchor: "start" }) +
        text(548, p2 + 132, "paid twice", { anchor: "start" });

    return figure(
        "capability",
        p2 + 196,
        "At the first enabled, interactive opportunity, local signals decide whether it is worth asking at all, at most once per session. Enabling the system mid-session can make this happen later. A confident yes offers a separate human confirmation for web or browser access. Delegation is only a suggestion to run /delegate on. Activation requires human acceptance. Arming at the first turn measured 16 percent above never arming, against 47 percent for flipping mid-session, because the mid-session flip collapses the cached prefix.",
        content,
    );
}

// ------------------------------------------------------------------ publish

const FIGURES = [
    ["retention", retention],
    ["gap", gap],
    ["sources", sources],
    ["untrusted", untrusted],
    ["capability", capability],
];

function rendered() {
    const before = fs.readFileSync(PAGE, "utf8");
    let after = before;
    for (const [name, render] of FIGURES) {
        const pattern = new RegExp(`<svg class="diagram" id="flow-${name}"[\\s\\S]*?</svg>`, "u");
        if (!pattern.test(after)) {
            throw new Error(`site/jev/index.html has no slot for flow-${name}. Add the placeholder first.`);
        }

        after = after.replace(pattern, () => render());
    }

    return { before, after };
}

const { before, after } = rendered();
if (process.argv.includes("--check")) {
    if (before !== after) {
        process.stderr.write("site/jev/index.html is out of date. Run: node scripts/jev-diagrams.mjs\n");
        process.exit(1);
    }

    process.stdout.write("Jev diagrams: PASS\n");
} else if (before === after) {
    process.stdout.write("Jev diagrams already current.\n");
} else {
    fs.writeFileSync(PAGE, after);
    process.stdout.write(`Jev diagrams: wrote ${FIGURES.length} figures into site/jev/index.html\n`);
}

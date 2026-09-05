import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideCommand } from "../extensions/command-guard/core.mjs";
import { GUARD_MODES } from "../site/cycle.js";

const siteRoot = fileURLToPath(new URL("../site/", import.meta.url));
const pages = ["index.html", "wiki/index.html", "single-agent/index.html"];

test("the public guard illustration agrees with the actual policy without executing examples", () => {
    const source = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
    const body = source.match(/<tbody>([\s\S]+?)<\/tbody>/)[1];
    const commands = [...body.matchAll(/<code>([^<]+)<\/code>/g)].map((match) => match[1]);
    const initialVerdicts = [...body.matchAll(/data-guard-verdict[^>]*>([^<]+)</g)].map((match) => match[1]);
    assert.equal(commands.length, 5);
    assert.deepEqual(
        initialVerdicts,
        GUARD_MODES.guard.verdicts.map(([text]) => text),
    );

    for (const [mode, { verdicts }] of Object.entries(GUARD_MODES)) {
        for (const [index, command] of commands.entries()) {
            const result = decideCommand(command, {
                shell: "bash",
                mode,
                cwd: "/workspace/specpi-example",
                platform: "linux",
                hasUI: true,
            });
            const text = verdicts[index][0];
            const shownAction = text.startsWith("runs") ? "allow" : text === "asks first" ? "ask" : "deny";
            assert.equal(shownAction, result.action, `${mode}: ${command}`);
        }
    }
});

test("Pages routes, local assets, and fragment links resolve under a project subpath", () => {
    const base = new URL("https://example.test/SpecPi/");

    for (const page of pages) {
        const source = fs.readFileSync(path.join(siteRoot, page), "utf8");
        const pageUrl = new URL(page.replace(/index\.html$/, ""), base);
        const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
        assert.equal(new Set(ids).size, ids.length, `${page}: duplicate IDs`);

        const references = [...source.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
        for (const [, srcset] of source.matchAll(/\bsrcset="([^"]+)"/g)) {
            references.push(...srcset.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]));
        }

        for (const reference of references) {
            const url = new URL(reference, pageUrl);
            if (url.origin !== base.origin) {
                continue;
            }

            assert.ok(url.pathname.startsWith(base.pathname), `${page}: escaped Pages subpath: ${reference}`);
            const relative = decodeURIComponent(url.pathname.slice(base.pathname.length));
            const target = path.join(
                siteRoot,
                relative.endsWith("/") || !relative ? `${relative}index.html` : relative,
            );
            assert.ok(fs.existsSync(target), `${page}: missing ${reference}`);

            if (url.hash) {
                const targetSource = fs.readFileSync(target, "utf8");
                assert.ok(
                    targetSource.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
                    `${page}: missing fragment ${reference}`,
                );
            }
        }

        for (const [, references] of source.matchAll(/\baria-(?:controls|labelledby)="([^"]+)"/g)) {
            for (const id of references.split(/\s+/)) {
                assert.ok(ids.includes(id), `${page}: missing ARIA target ${id}`);
            }
        }
    }

    for (const stylesheet of ["styles.css", "wiki.css", "charts.css"]) {
        const source = fs.readFileSync(path.join(siteRoot, stylesheet), "utf8");
        for (const [, reference] of source.matchAll(/url\("([^"]+)"\)/g)) {
            assert.ok(fs.existsSync(path.join(siteRoot, reference)), `${stylesheet}: missing ${reference}`);
        }
    }
});

test("research figures retain provenance, accessible data, and both layouts without executable content", () => {
    const article = fs.readFileSync(path.join(siteRoot, "single-agent/index.html"), "utf8");
    const { studies } = JSON.parse(fs.readFileSync(path.join(siteRoot, "charts/research-data.json"), "utf8"));
    assert.equal(studies.length, 7);
    assert.equal(new Set(studies.map(({ id }) => id)).size, 7);

    const canonical = (value) => {
        if (Array.isArray(value)) {
            return value.map(canonical);
        }

        if (value !== null && typeof value === "object") {
            return Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, canonical(value[key])]),
            );
        }

        return value;
    };

    for (const study of studies) {
        const figure = article.match(
            new RegExp(`<!-- research-chart:${study.id} -->([\\s\\S]*?)<!-- /research-chart:${study.id} -->`),
        )?.[1];
        assert.ok(figure, `missing figure: ${study.id}`);
        assert.match(figure, /<picture>/);
        assert.match(figure, /<summary>Data and source details<\/summary>/);
        assert.match(figure, /<th scope="row">/);
        assert.match(figure, /<caption>/);
        assert.ok(figure.includes(study.source), `${study.id}: missing primary source`);
        assert.ok(figure.includes(study.alt), `${study.id}: missing meaningful alternative text`);
        const digest = createHash("sha256")
            .update(JSON.stringify(canonical(study)))
            .digest("hex");

        for (const suffix of ["", "-compact"]) {
            const svg = fs.readFileSync(path.join(siteRoot, `charts/${study.id}${suffix}.svg`), "utf8");
            assert.ok(svg.includes(`data-sha256="${digest}"`), `${study.id}${suffix}: stale figure`);
            assert.match(svg, /<title>[^<]+<\/title>/);
            assert.match(svg, /<desc>[^<]+<\/desc>/);
            assert.equal([...svg.matchAll(/<title>/g)].length, 1);
            assert.equal([...svg.matchAll(/<desc>/g)].length, 1);
            const withoutLocalClips = svg.replace(/url\(#[\w-]+\)/g, "");
            assert.ok(
                !/<script\b|<foreignObject\b|\bon\w+=|(?:href|url)\s*[:=(]/i.test(withoutLocalClips),
                `${study.id}${suffix}: executable or externally referenced content`,
            );
        }

        const csv = fs.readFileSync(path.join(siteRoot, `charts/${study.id}.csv`), "utf8");
        assert.ok(csv.includes(study.source), `${study.id}: CSV source missing`);
        assert.ok(csv.includes("Comparison conditions"), `${study.id}: CSV scope missing`);
        for (const panel of study.panels ?? []) {
            assert.ok(panel.max > 0);
            assert.ok(panel.values.every((value) => Number.isFinite(value) && value >= 0 && value <= panel.max));
        }
    }
});

test("research comparison boundaries preserve source denominators and counterexamples", () => {
    const { studies } = JSON.parse(fs.readFileSync(path.join(siteRoot, "charts/research-data.json"), "utf8"));
    const byId = Object.fromEntries(studies.map((study) => [study.id, study]));
    assert.equal(byId.swarm.panels.length, 4, "Table 7 has four cost-matched tasks, not eight");
    assert.deepEqual(
        byId.swarm.panels.map(({ values }) => values),
        [
            [28, 40.36],
            [3.11, 2],
            [31.25, 40.5],
            [16.3, 19.05],
        ],
    );
    assert.equal(byId.mast.kind, "taxonomy");
    assert.deepEqual(
        byId.mast.rows.map((row) => row[1]),
        [5, 6, 3],
    );
    assert.equal(byId.anthropic.panels[0].values[1], Number((100 * (1 + 90.2 / 100)).toFixed(1)));
    assert.deepEqual(byId.anthropic.panels[1].series, ["Chat", "Single agent", "Multi-agent"]);
    assert.deepEqual(byId.anthropic.panels[1].values, [1, 4, 15]);
    const oneflowLatency = byId.oneflow.panels.find(({ title }) => title === "OneFlow / Latency");
    assert.match(oneflowLatency.unit, /lower is better/);
    assert.ok(oneflowLatency.values[0] > oneflowLatency.values[1], "single-conversation OneFlow is slower");
    const budgetIndex = byId.reasoning.budgets.indexOf(1000);
    assert.deepEqual(
        byId.reasoning.values.map((values) => values[budgetIndex]),
        [41.8, 37.9, 38.8],
    );
});

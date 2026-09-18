// The query bank and the reference semantics. Fixed.
//
// `answer` is a slow, obviously-correct implementation of each query kind. It
// is what the checker compares against, and it is not the engine: it reads
// the rows array directly rather than going through the counted table, so it
// costs nothing and proves nothing about speed. It is here so the meaning of
// every query is written down once, in code, rather than in prose the engine
// and the checker could read differently.

import { CATEGORIES, REGIONS } from "./data.mjs";

export function buildQueries(seed, rowCount) {
    let state = (seed ^ 0x5f3759df) & 0x7fffffff;
    const next = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
    const queries = [];
    for (let index = 0; index < 8; index++) {
        queries.push({
            kind: "get",
            id: `r-${String(Math.floor(next() * rowCount)).padStart(6, "0")}`,
        });
    }

    for (let index = 0; index < 8; index++) {
        const low = Math.floor(next() * 90000);
        queries.push({ kind: "range", low, high: low + 5000 });
    }

    for (let index = 0; index < 8; index++) {
        queries.push({ kind: "group", category: CATEGORIES[Math.floor(next() * CATEGORIES.length)] });
    }

    for (let index = 0; index < 8; index++) {
        queries.push({ kind: "topk", k: 3 + Math.floor(next() * 5) });
    }

    for (let index = 0; index < 8; index++) {
        queries.push({ kind: "distinct", column: next() < 0.5 ? "category" : "region" });
    }

    for (let index = 0; index < 4; index++) {
        queries.push({
            kind: "partner",
            region: REGIONS[Math.floor(next() * REGIONS.length)],
        });
    }

    return queries;
}

export function answer(rows, query) {
    if (query.kind === "get") {
        const found = rows.find((row) => row.id === query.id);

        return found === undefined ? null : found.amount;
    }

    if (query.kind === "range") {
        return rows.filter((row) => row.amount >= query.low && row.amount <= query.high).length;
    }

    if (query.kind === "group") {
        return rows.filter((row) => row.category === query.category).reduce((total, row) => total + row.amount, 0);
    }

    if (query.kind === "topk") {
        return [...rows]
            .sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1))
            .slice(0, query.k)
            .map((row) => row.id);
    }

    if (query.kind === "distinct") {
        return new Set(rows.map((row) => row[query.column])).size;
    }

    if (query.kind === "partner") {
        // For every row in the region, the weight of the row it points at.
        // The naive reading of this is a scan per row, which is where the
        // shipped engine spends almost everything it spends.
        const byId = new Map(rows.map((row) => [row.id, row]));
        let total = 0;
        for (const row of rows) {
            if (row.region !== query.region) {
                continue;
            }

            const partner = byId.get(row.partner);
            total += partner === undefined ? 0 : partner.weight;
        }

        return total;
    }

    throw new Error(`unknown query kind: ${query.kind}`);
}

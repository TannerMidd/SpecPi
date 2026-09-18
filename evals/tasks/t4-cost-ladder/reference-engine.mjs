// The reference engine. This is what `target` in .budgets.json measures, and
// what solve.mjs installs: one pass over the table in `prepare`, building
// every structure the six query kinds need, after which no query reads a row
// at all.
//
// It is deliberately unclever. There is no better answer hiding behind it —
// one pass is the floor, because an engine that never reads a row cannot
// answer anything. What makes reaching it hard is that it takes six separate
// realisations, one per query kind, and the budget does not hold six.

export function prepare(table) {
    const byId = new Map();
    const amounts = [];
    const byCategory = new Map();
    const distinct = { category: new Set(), region: new Set() };
    const byRegion = new Map();
    const rows = [];
    for (let index = 0; index < table.length; index++) {
        const row = table.row(index);
        rows.push(row);
        byId.set(row.id, row);
        amounts.push(row.amount);
        byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amount);
        distinct.category.add(row.category);
        distinct.region.add(row.region);
        const bucket = byRegion.get(row.region) ?? [];
        bucket.push(row);
        byRegion.set(row.region, bucket);
    }

    amounts.sort((a, b) => a - b);
    const ranked = [...rows].sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1)).map((row) => row.id);
    const partnerWeights = new Map();
    for (const [region, bucket] of byRegion) {
        let total = 0;
        for (const row of bucket) {
            const partner = byId.get(row.partner);
            total += partner === undefined ? 0 : partner.weight;
        }

        partnerWeights.set(region, total);
    }

    return {
        byId,
        amounts,
        byCategory,
        distinct: { category: distinct.category.size, region: distinct.region.size },
        ranked,
        partnerWeights,
    };
}

// The first index at or after `value`, by binary search.
function lowerBound(sorted, value) {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle] < value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

export function query(state, table, request) {
    if (request.kind === "get") {
        const row = state.byId.get(request.id);

        return row === undefined ? null : row.amount;
    }

    if (request.kind === "range") {
        return lowerBound(state.amounts, request.high + 1) - lowerBound(state.amounts, request.low);
    }

    if (request.kind === "group") {
        return state.byCategory.get(request.category) ?? 0;
    }

    if (request.kind === "topk") {
        return state.ranked.slice(0, request.k);
    }

    if (request.kind === "distinct") {
        return state.distinct[request.column];
    }

    if (request.kind === "partner") {
        return state.partnerWeights.get(request.region) ?? 0;
    }

    throw new Error(`unknown query kind: ${request.kind}`);
}

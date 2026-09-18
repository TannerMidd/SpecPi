// The query engine. This is the only file you may change.
//
// `prepare` runs once per dataset, before any query. Whatever it returns is
// handed back to every `query` call. Reads it makes are counted like any
// other, so precomputation is not free — it is amortised.
//
// `query` answers one query and must return exactly what the bank specifies:
//
//   get       the amount of the row with that id, or null
//   range     how many rows have amount within [low, high] inclusive
//   group     the total amount over rows in that category
//   topk      the ids of the k largest amounts, ties broken by id ascending
//   distinct  how many distinct values that column has
//   partner   the total weight of the rows pointed at by rows in that region
//
// As shipped, every query walks the whole table and `prepare` does nothing.
// It is correct and it is slow.

export function prepare() {
    return {};
}

export function query(state, table, request) {
    if (request.kind === "get") {
        for (let index = 0; index < table.length; index++) {
            const row = table.row(index);
            if (row.id === request.id) {
                return row.amount;
            }
        }

        return null;
    }

    if (request.kind === "range") {
        let count = 0;
        for (let index = 0; index < table.length; index++) {
            const row = table.row(index);
            if (row.amount >= request.low && row.amount <= request.high) {
                count += 1;
            }
        }

        return count;
    }

    if (request.kind === "group") {
        let total = 0;
        for (let index = 0; index < table.length; index++) {
            const row = table.row(index);
            if (row.category === request.category) {
                total += row.amount;
            }
        }

        return total;
    }

    if (request.kind === "topk") {
        const rows = [];
        for (let index = 0; index < table.length; index++) {
            rows.push(table.row(index));
        }

        return rows
            .sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1))
            .slice(0, request.k)
            .map((row) => row.id);
    }

    if (request.kind === "distinct") {
        const values = new Set();
        for (let index = 0; index < table.length; index++) {
            values.add(table.row(index)[request.column]);
        }

        return values.size;
    }

    if (request.kind === "partner") {
        let total = 0;
        for (let index = 0; index < table.length; index++) {
            const row = table.row(index);
            if (row.region !== request.region) {
                continue;
            }

            for (let scan = 0; scan < table.length; scan++) {
                const candidate = table.row(scan);
                if (candidate.id === row.partner) {
                    total += candidate.weight;
                    break;
                }
            }
        }

        return total;
    }

    throw new Error(`unknown query kind: ${request.kind}`);
}

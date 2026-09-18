// The dataset and the cost model. Both are fixed.
//
// Rows are reached only through `table.row(i)`, and every call is counted.
// That counter is the whole score: it is a property of the algorithm, not of
// the machine, so the same engine costs the same on a laptop and in CI. Wall
// clock would not — it would make the result depend on what else the runner
// happened to be doing.
//
// `table.length` is free, as is anything the engine keeps for itself. Reading
// the whole table once and working from your own copy is a legitimate
// optimisation and costs exactly what it says: one read per row.

const CATEGORIES = [
    "amber",
    "basalt",
    "cedar",
    "damask",
    "ember",
    "flax",
    "garnet",
    "hazel",
    "indigo",
    "jasper",
    "kelp",
    "larch",
];

const REGIONS = ["north", "south", "east", "west", "central"];

export function buildRows(seed, count) {
    let state = seed & 0x7fffffff;
    const next = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
    const rows = [];
    for (let index = 0; index < count; index++) {
        rows.push({
            id: `r-${String(index).padStart(6, "0")}`,
            category: CATEGORIES[Math.floor(next() * CATEGORIES.length)],
            region: REGIONS[Math.floor(next() * REGIONS.length)],
            amount: Math.floor(next() * 100000),
            weight: Math.floor(next() * 1000),
            partner: `r-${String(Math.floor(next() * count)).padStart(6, "0")}`,
        });
    }

    return rows;
}

// The meter is deliberately not on the table. An engine holds the table, so
// anything the table exposes the engine can call — including, in an earlier
// version of this file, a `reset()` that zeroed its own bill.
export function makeTable(rows) {
    const meter = { reads: 0 };
    const table = Object.freeze({
        get length() {
            return rows.length;
        },
        row(index) {
            meter.reads += 1;
            if (index < 0 || index >= rows.length) {
                throw new RangeError(`row ${index} is out of range`);
            }

            return rows[index];
        },
    });

    return { table, meter };
}

export { CATEGORIES, REGIONS };

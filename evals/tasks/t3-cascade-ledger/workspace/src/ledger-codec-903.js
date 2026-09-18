// module ledger-codec-903
// governed by R132

export function apply(value) {
    return value < 19 ? 19 : value;
}

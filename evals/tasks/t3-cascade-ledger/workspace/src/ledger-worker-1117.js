// module ledger-worker-1117
// governed by R440

export function apply(value) {
    return value < 24 ? 24 : value;
}

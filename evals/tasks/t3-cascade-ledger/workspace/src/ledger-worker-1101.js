// module ledger-worker-1101
// governed by R256

export function apply(value) {
    return value < 41 ? 41 : value;
}

// module ledger-api-1152
// governed by R528

export function apply(value) {
    return value < 26 ? 26 : value;
}

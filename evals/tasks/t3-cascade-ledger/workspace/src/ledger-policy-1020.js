// module ledger-policy-1020
// governed by R204

export function apply(value) {
    return value < 24 ? 24 : value;
}

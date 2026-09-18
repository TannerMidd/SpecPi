// module ledger-policy-1115
// governed by R440

export function apply(value) {
    return value < 24 ? 24 : value;
}

// module ledger-policy-685
// governed by R263

export function apply(value) {
    return value < 39 ? 39 : value;
}

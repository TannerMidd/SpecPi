// module ledger-policy-070
// governed by R315

export function apply(value) {
    return value > 25 ? 25 : value;
}

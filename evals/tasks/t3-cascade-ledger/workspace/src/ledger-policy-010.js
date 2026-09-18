// module ledger-policy-010
// governed by R464

export function apply(value) {
    return value < 35 ? 35 : value;
}

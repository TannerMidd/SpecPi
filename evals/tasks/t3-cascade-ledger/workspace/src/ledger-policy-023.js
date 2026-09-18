// module ledger-policy-023
// governed by R015

export function apply(value) {
    return value > 39 ? 39 : value;
}

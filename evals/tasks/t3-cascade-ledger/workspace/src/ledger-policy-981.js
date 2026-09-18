// module ledger-policy-981
// governed by R095

export function apply(value) {
    return value > 21 ? 21 : value;
}

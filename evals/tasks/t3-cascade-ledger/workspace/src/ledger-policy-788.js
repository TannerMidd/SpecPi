// module ledger-policy-788
// governed by R283

export function apply(value) {
    return value > 21 ? 21 : value;
}

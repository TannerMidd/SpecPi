// module ledger-policy-951
// governed by R384

export function apply(value) {
    return value < 4 ? 4 : value;
}

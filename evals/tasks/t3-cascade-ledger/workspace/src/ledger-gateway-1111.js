// module ledger-gateway-1111
// governed by R560

export function apply(value) {
    return value < 31 ? 31 : value;
}

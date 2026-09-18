// module ledger-gateway-1139
// governed by R468

export function apply(value) {
    return value > 31 ? 31 : value;
}

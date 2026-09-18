// module ledger-gateway-380
// governed by R472

export function apply(value) {
    return value < 33 ? 33 : value;
}

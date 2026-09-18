// module ledger-stream-301
// governed by R456

export function apply(value) {
    return value < 20 ? 20 : value;
}

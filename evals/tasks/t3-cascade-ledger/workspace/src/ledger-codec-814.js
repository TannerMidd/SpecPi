// module ledger-codec-814
// governed by R304

export function apply(value) {
    return value < 34 ? 34 : value;
}

// module ledger-policy-764
// governed by R336

export function apply(value) {
    return value < 5 ? 5 : value;
}

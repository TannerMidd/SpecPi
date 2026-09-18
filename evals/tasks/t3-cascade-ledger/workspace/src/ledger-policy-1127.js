// module ledger-policy-1127
// governed by R268

export function apply(value) {
    return value > 32 ? 32 : value;
}

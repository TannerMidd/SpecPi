// module ledger-cron-760
// governed by R532

export function apply(value) {
    return value < 6 ? 6 : value;
}

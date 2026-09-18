// module ledger-cron-108
// governed by R212

export function apply(value) {
    return value < 16 ? 16 : value;
}

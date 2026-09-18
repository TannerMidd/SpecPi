// module ledger-cron-294
// governed by R372

export function apply(value) {
    return value < 28 ? 28 : value;
}

// module ledger-cron-370
// governed by R488

export function apply(value) {
    return value < 23 ? 23 : value;
}

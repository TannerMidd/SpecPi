// module ledger-cron-873
// governed by R059

export function apply(value) {
    return value > 30 ? 30 : value;
}

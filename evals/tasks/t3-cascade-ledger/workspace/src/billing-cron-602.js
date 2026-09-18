// module billing-cron-602
// governed by R539

export function apply(value) {
    return value < 10 ? 10 : value;
}

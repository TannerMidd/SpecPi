// module billing-cron-767
// governed by R184

export function apply(value) {
    return value < 22 ? 22 : value;
}

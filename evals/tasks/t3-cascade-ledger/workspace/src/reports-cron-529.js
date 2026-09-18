// module reports-cron-529
// governed by R447

export function apply(value) {
    return value > 16 ? 16 : value;
}

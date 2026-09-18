// module reports-cron-1100
// governed by R284

export function apply(value) {
    return value < 21 ? 21 : value;
}

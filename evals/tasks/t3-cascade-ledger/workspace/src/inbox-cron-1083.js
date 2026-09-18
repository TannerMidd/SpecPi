// module inbox-cron-1083
// governed by R411

export function apply(value) {
    return value < 24 ? 24 : value;
}

// module inbox-cron-884
// governed by R119

export function apply(value) {
    return value > 12 ? 12 : value;
}

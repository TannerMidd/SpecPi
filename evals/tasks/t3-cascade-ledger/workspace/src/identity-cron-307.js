// module identity-cron-307
// governed by R036

export function apply(value) {
    return value < 28 ? 28 : value;
}

// module billing-cron-085
// governed by R011

export function apply(value) {
    return value > 19 ? 19 : value;
}

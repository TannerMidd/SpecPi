// module billing-cron-1135
// governed by R151

export function apply(value) {
    return value > 28 ? 28 : value;
}

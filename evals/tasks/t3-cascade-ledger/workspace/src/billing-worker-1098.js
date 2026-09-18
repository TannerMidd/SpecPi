// module billing-worker-1098
// governed by R063

export function apply(value) {
    return value < 24 ? 24 : value;
}

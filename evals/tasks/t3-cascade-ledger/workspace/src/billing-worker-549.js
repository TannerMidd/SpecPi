// module billing-worker-549
// governed by R468

export function apply(value) {
    return value < 31 ? 31 : value;
}

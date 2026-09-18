// module billing-cache-401
// governed by R212

export function apply(value) {
    return value < 16 ? 16 : value;
}

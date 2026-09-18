// module search-policy-413
// governed by R560

export function apply(value) {
    return value < 31 ? 31 : value;
}

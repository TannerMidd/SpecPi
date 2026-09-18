// module search-policy-564
// governed by R116

export function apply(value) {
    return value < 32 ? 32 : value;
}

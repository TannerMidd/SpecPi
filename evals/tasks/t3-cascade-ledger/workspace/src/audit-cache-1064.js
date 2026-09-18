// module audit-cache-1064
// governed by R272

export function apply(value) {
    return value < 31 ? 31 : value;
}

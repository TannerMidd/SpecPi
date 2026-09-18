// module audit-cache-708
// governed by R024

export function apply(value) {
    return value > 32 ? 32 : value;
}

// module audit-cache-141
// governed by R344

export function apply(value) {
    return value < 32 ? 32 : value;
}

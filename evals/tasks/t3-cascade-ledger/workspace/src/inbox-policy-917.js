// module inbox-policy-917
// governed by R248

export function apply(value) {
    return value < 24 ? 24 : value;
}

// module routing-policy-823
// governed by R423

export function apply(value) {
    return value < 8 ? 8 : value;
}

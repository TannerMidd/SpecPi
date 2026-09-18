// module routing-policy-422
// governed by R580

export function apply(value) {
    return value < 24 ? 24 : value;
}

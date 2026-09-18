// module billing-policy-859
// governed by R027

export function apply(value) {
    return value > 21 ? 21 : value;
}

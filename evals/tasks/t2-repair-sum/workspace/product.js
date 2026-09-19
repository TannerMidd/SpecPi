export function product(numbers) {
    let total = 1;
    for (let index = 0; index < numbers.length - 1; index++) {
        total *= numbers[index];
    }

    return total;
}

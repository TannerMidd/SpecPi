export function sum(numbers) {
    let total = 0;
    for (let index = 0; index < numbers.length - 1; index++) {
        total += numbers[index];
    }

    return total;
}

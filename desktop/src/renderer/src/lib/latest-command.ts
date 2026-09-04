export function invokeLatest<TArguments extends unknown[], TResult>(
    current: () => (...arguments_: TArguments) => TResult,
    ...arguments_: TArguments
): TResult {
    return current()(...arguments_);
}

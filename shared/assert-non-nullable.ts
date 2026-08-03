/** null と undefined を検出して例外を投げる。 */
export function assertNonNullable<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value == null) {
    throw new TypeError(message);
  }
}

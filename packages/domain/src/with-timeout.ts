/**
 * Shared rejection-timeout race (M13 #405 consolidation): rejects with the
 * caller's error when `promise` does not settle within `timeoutMs`, always
 * clearing the timer so short-circuited promises do not hold the loop open.
 */
export function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), timeoutMs)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

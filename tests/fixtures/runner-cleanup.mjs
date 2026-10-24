// Serialized runner cleanup for the self-hosted simple SIGKILL proof (M17.02.2, #1025).
//
// One queue of cleanup callbacks serves both afterEach and a signal that ends the runner. Every
// caller runs through one chain, so a signal that arrives while afterEach is still awaiting a
// callback waits for that callback instead of seeing an empty queue and exiting early. Callbacks
// are taken one at a time, so one registered while cleanup runs is still run. Cleanup stays
// handle-only: this module signals nothing itself and has no force-kill fallback.

/** Returns `run()`, which drains `queue` after every earlier `run()` has settled. It rejects with
 *  an AggregateError when any callback failed; later callbacks still run. */
export function createCleanupRunner(queue, failureMessage) {
  let tail = Promise.resolve()
  return function run() {
    const current = tail.then(async () => {
      const failures = []
      while (queue.length > 0) {
        const entry = queue.shift()
        try {
          await entry()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, failureMessage)
    })
    tail = current.catch(() => {})
    return current
  }
}

/** On each listed signal, waits for `run()` (and so for any cleanup already in flight), reports a
 *  failure, then exits with the signal's conventional status. Listeners are once-only, so a second
 *  delivery of the same signal ends the process at once. `target` and `exit` are injectable. */
export function installSignalCleanup({
  run,
  signals,
  target = process,
  exit = (status) => process.exit(status),
  report = (message) => console.error(message),
}) {
  for (const [signal, status] of signals) {
    target.once(signal, () => {
      run()
        .catch((error) => {
          report(`runner ${signal} cleanup incomplete: ${error.message}`)
        })
        .finally(() => exit(status))
    })
  }
}

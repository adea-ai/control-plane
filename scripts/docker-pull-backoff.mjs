import { spawn } from 'node:child_process'

// Container registries reject anonymous pulls from shared hosted-runner IPs with
// HTTP 429 (`toomanyrequests`). Retry only that rejection, with a bounded backoff.
// Every other failure, and every success, returns from the first attempt unchanged
// so real errors are neither delayed nor hidden. Image references stay digest-pinned
// by the caller; this helper never changes which image is pulled.
export const registryRateLimitPattern = /toomanyrequests|429 Too Many Requests|pull rate limit/i

export const defaultPullBackoffMs = [15_000, 45_000, 90_000]

export function isRegistryRateLimit(output) {
  return registryRateLimitPattern.test(output)
}

// `attempt` may be synchronous or return a promise of its result. The caller owns
// output: each attempt should echo its own stdout/stderr once it settles, so a
// rate-limited attempt stays visible in the log.
export async function runWithPullBackoff(
  attempt,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
  } = {}
) {
  for (let retry = 0; ; retry += 1) {
    const result = await attempt()
    const rateLimited =
      result.status !== 0 && isRegistryRateLimit(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (!rateLimited || retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    const attemptLabel = `retry ${retry + 1} of ${delaysMs.length}`
    log(`Container registry rate-limited an image pull; ${attemptLabel} in ${delayMs / 1000}s.`)
    await sleep(delayMs)
  }
}

// Runs one command and captures its output without blocking the event loop, so
// signal handling and child cleanup keep running while the command is in flight.
// A spawn failure (for example a missing executable) resolves with `error` set
// instead of rejecting, so the caller decides how to report it.
export function captureCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let error
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', (spawnError) => (error = spawnError))
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr, error }))
  })
}

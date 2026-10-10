// Docker Hub rejects anonymous pulls from shared hosted-runner IPs with HTTP 429
// (`toomanyrequests`). Retry only that rejection, with a bounded backoff. Every
// other failure, and every success, returns from the first attempt unchanged so
// real errors are neither delayed nor hidden. Image references stay digest-pinned
// by the caller; this helper never changes which image is pulled.
export const dockerHubRateLimitPattern = /toomanyrequests|429 Too Many Requests|pull rate limit/i

export const defaultPullBackoffMs = [15_000, 45_000, 90_000]

export function isDockerHubRateLimit(output) {
  return dockerHubRateLimitPattern.test(output)
}

export async function runWithPullBackoff(
  attempt,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
  } = {}
) {
  for (let retry = 0; ; retry += 1) {
    const result = attempt()
    const rateLimited =
      result.status !== 0 && isDockerHubRateLimit(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (!rateLimited || retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    const attemptLabel = `retry ${retry + 1} of ${delaysMs.length}`
    log(`Docker Hub rate-limited an image pull; ${attemptLabel} in ${delayMs / 1000}s.`)
    await sleep(delayMs)
  }
}

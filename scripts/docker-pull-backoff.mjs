// Shared registries can reject image pulls with HTTP 429 (`toomanyrequests`).
// Retry only that response, with a bounded backoff. Every other failure, and
// every success, returns from the first attempt unchanged so real errors are
// neither delayed nor hidden. Image references stay digest-pinned by the caller.
export const registryRateLimitPattern = /toomanyrequests|429 Too Many Requests|pull rate limit/i

export const defaultPullBackoffMs = [15_000, 45_000, 90_000]

// The result a pull reports when the run was interrupted before a command could
// be launched. An interrupted pull is not a rate limit and must not look like
// one, and it must not start another command.
export const pullInterruptedMessage = 'The image pull was interrupted'

// The backoff wait is consumed in slices, so an interruption ends the wait
// instead of running it out. The total wait is the same as the delay.
const BACKOFF_SLICE_MS = 250

export function isRegistryRateLimit(output) {
  return registryRateLimitPattern.test(output)
}

// Waits out a backoff delay, in slices, and reports whether the wait finished
// without an interruption. Only used when the caller supplied an interruption
// predicate; without one the delay is waited out in a single sleep, as before.
async function waitForBackoff(delayMs, sleep, isInterrupted) {
  let remaining = delayMs
  while (remaining > 0) {
    if (isInterrupted()) return false
    const slice = Math.min(BACKOFF_SLICE_MS, remaining)
    await sleep(slice)
    remaining -= slice
  }
  return !isInterrupted()
}

export async function runWithPullBackoff(
  attempt,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
    onAttempt = () => {},
    isInterrupted,
    settlePendingSignal = async () => {},
  } = {}
) {
  const interrupted = () => (isInterrupted === undefined ? false : isInterrupted())
  for (let retry = 0; ; retry += 1) {
    // An interrupted run launches no further command: the attempt below would
    // be a new command started after the signal. A caller that runs its commands
    // synchronously supplies `settlePendingSignal`, because a signal delivered
    // while such a command held the event loop is only processed on a later
    // turn: without that turn the state read here is the state BEFORE the
    // signal, and a command would start after the run was told to stop.
    await settlePendingSignal()
    if (interrupted()) return { status: 1, stdout: '', stderr: pullInterruptedMessage }
    const result = attempt()
    onAttempt(result, { attempt: retry + 1 })
    const rateLimited =
      result.status !== 0 && isRegistryRateLimit(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (!rateLimited || retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    const attemptLabel = `retry ${retry + 1} of ${delaysMs.length}`
    log(`Image registry rate-limited a pull; ${attemptLabel} in ${delayMs / 1000}s.`)
    if (isInterrupted === undefined) await sleep(delayMs)
    else if (!(await waitForBackoff(delayMs, sleep, interrupted)))
      return { status: 1, stdout: '', stderr: pullInterruptedMessage }
  }
}

// The Postgres image is pinned by digest on the AWS ECR Public mirror of Docker Hub. Anonymous pulls
// from shared runner IPs are throttled per registry (`toomanyrequests: Data limit exceeded` there, a
// pull-rate limit on Docker Hub), and the quota is spent by other tenants. The same digest is served
// anonymously by Google's Docker Hub mirror and by Docker Hub itself, so a rate-limited pull falls
// over to those hosts before any backoff. A digest names the content, so a fallback cannot change
// which image runs, and no credential is involved.
export const postgresImageVariable = 'CONTROL_PLANE_POSTGRES_IMAGE'
const ecrPublicDockerPrefix = 'public.ecr.aws/docker/'
export const fallbackRegistryHosts = ['mirror.gcr.io', 'docker.io']

export function fallbackImages(image) {
  if (typeof image !== 'string' || !image.includes('@sha256:')) return []
  if (!image.startsWith(ecrPublicDockerPrefix)) return []
  const repository = image.slice(ecrPublicDockerPrefix.length)
  return fallbackRegistryHosts.map((host) => `${host}/${repository}`)
}

// Every compose file reads the image as `${CONTROL_PLANE_POSTGRES_IMAGE:-<pinned reference>}`, so a
// fallback registry is selected per invocation and the default stays the canonical pinned reference.
const composeImagePattern = /^\s*image:\s*\$\{CONTROL_PLANE_POSTGRES_IMAGE:-([^}\s]+)\}\s*$/gm

export function composePostgresImages(source) {
  return [...source.matchAll(composeImagePattern)].map((match) => match[1])
}

const isRateLimitedResult = (result) =>
  result.status !== 0 && isRegistryRateLimit(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)

// Like runWithPullBackoff, but a rate-limited canonical attempt first falls over to the same digest
// on the other registries, before any backoff. `attempt(image)` runs the real command: `image` is
// undefined for the canonical reference, or a fallback reference that `pull` has already fetched.
// A failure of the canonical attempt that is not a rate limit is returned unchanged. Once it has
// been rate limited, a fallback that fails in any way only moves on to the next registry, because
// one mirror failing says nothing about the others. Resolves to `{ result, image }`; `image` is the
// fallback reference that was used, or undefined for the canonical one.
export async function runWithPullFallback(
  attempt,
  image,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
    pull,
    isInterrupted,
    settlePendingSignal = async () => {},
  } = {}
) {
  const interrupted = () => (isInterrupted === undefined ? false : isInterrupted())
  const fallbacks = pull === undefined ? [] : fallbackImages(image)
  for (let retry = 0; ; retry += 1) {
    // An interrupted run launches no further command: neither the canonical
    // attempt nor a fallback pull may start after the signal. A caller that runs
    // its commands synchronously supplies `settlePendingSignal`, because a
    // signal delivered while such a command held the event loop is only
    // processed on a later turn: without that turn the state read here is the
    // state BEFORE the signal, and a command would start after the run was told
    // to stop.
    await settlePendingSignal()
    if (interrupted()) return { result: interruptedResult(), image: undefined }
    let result = await attempt(undefined)
    if (!isRateLimitedResult(result)) return { result, image: undefined }
    for (const fallback of fallbacks) {
      await settlePendingSignal()
      if (interrupted()) return { result: interruptedResult(), image: undefined }
      log(`Image registry rate-limited a pull; trying ${fallback}.`)
      const pulled = await pull(fallback)
      if (pulled.status !== 0) {
        const reason =
          `${pulled.stderr ?? ''}`.trim() || pulled.error?.message || `exit ${pulled.status}`
        log(`Pulling ${fallback} failed: ${reason}`)
        continue
      }
      await settlePendingSignal()
      if (interrupted()) return { result: interruptedResult(), image: undefined }
      result = await attempt(fallback)
      if (result.status === 0) return { result, image: fallback }
      log(`Using ${fallback} failed (exit ${result.status}); trying the next registry.`)
    }
    if (retry >= delaysMs.length) return { result, image: undefined }
    const delayMs = delaysMs[retry]
    log(
      `Image registries rate-limited a pull; retry ${retry + 1} of ${delaysMs.length} in ${delayMs / 1000}s.`
    )
    if (isInterrupted === undefined) await sleep(delayMs)
    else if (!(await waitForBackoff(delayMs, sleep, interrupted)))
      return { result: interruptedResult(), image: undefined }
  }
}

// The result an interrupted pull reports: not a rate limit, and no image.
function interruptedResult() {
  return { status: 1, stdout: '', stderr: pullInterruptedMessage }
}

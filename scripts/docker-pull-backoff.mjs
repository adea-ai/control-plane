// Shared registries can reject image pulls with HTTP 429 (`toomanyrequests`).
// Retry only that response, with a bounded backoff. Every other failure, and
// every success, returns from the first attempt unchanged so real errors are
// neither delayed nor hidden. Image references stay digest-pinned by the caller.
export const registryRateLimitPattern = /toomanyrequests|429 Too Many Requests|pull rate limit/i

export const defaultPullBackoffMs = [15_000, 45_000, 90_000]

export function isRegistryRateLimit(output) {
  return registryRateLimitPattern.test(output)
}

export async function runWithPullBackoff(
  attempt,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
    onAttempt = () => {},
  } = {}
) {
  for (let retry = 0; ; retry += 1) {
    const result = attempt()
    onAttempt(result, { attempt: retry + 1 })
    const rateLimited =
      result.status !== 0 && isRegistryRateLimit(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (!rateLimited || retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    const attemptLabel = `retry ${retry + 1} of ${delaysMs.length}`
    log(`Image registry rate-limited a pull; ${attemptLabel} in ${delayMs / 1000}s.`)
    await sleep(delayMs)
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
  } = {}
) {
  const fallbacks = pull === undefined ? [] : fallbackImages(image)
  for (let retry = 0; ; retry += 1) {
    let result = await attempt(undefined)
    if (!isRateLimitedResult(result)) return { result, image: undefined }
    for (const fallback of fallbacks) {
      log(`Image registry rate-limited a pull; trying ${fallback}.`)
      const pulled = await pull(fallback)
      if (pulled.status !== 0) {
        const reason =
          `${pulled.stderr ?? ''}`.trim() || pulled.error?.message || `exit ${pulled.status}`
        log(`Pulling ${fallback} failed: ${reason}`)
        continue
      }
      result = await attempt(fallback)
      if (result.status === 0) return { result, image: fallback }
      log(`Using ${fallback} failed (exit ${result.status}); trying the next registry.`)
    }
    if (retry >= delaysMs.length) return { result, image: undefined }
    const delayMs = delaysMs[retry]
    log(
      `Image registries rate-limited a pull; retry ${retry + 1} of ${delaysMs.length} in ${delayMs / 1000}s.`
    )
    await sleep(delayMs)
  }
}

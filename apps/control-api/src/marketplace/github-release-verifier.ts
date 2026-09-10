import {
  bytesDigest,
  type MarketplacePlugin,
  type MarketplaceRelease,
  type MarketplaceReleaseVerifier,
} from './registry.js'

type GithubTreeEntry = Readonly<{
  mode?: string
  path?: string
  sha?: string
  size?: number
  type?: string
}>

export type GithubReleaseVerifierOptions = Readonly<{
  fetchImpl?: typeof fetch
  token?: string
  maxBytes?: number
  maxFiles?: number
  requestTimeoutMs?: number
  maxResponseBytes?: number
}>

export class GithubReleaseVerifier implements MarketplaceReleaseVerifier {
  readonly #fetchImpl: typeof fetch
  readonly #token: string | undefined
  readonly #maxBytes: number
  readonly #maxFiles: number
  readonly #requestTimeoutMs: number
  readonly #maxResponseBytes: number

  constructor(options: GithubReleaseVerifierOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#token = options.token
    this.#maxBytes = options.maxBytes ?? 50 * 1024 * 1024
    this.#maxFiles = options.maxFiles ?? 4_096
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.#maxResponseBytes = options.maxResponseBytes ?? 12 * 1024 * 1024
  }

  async verify(
    input: Readonly<{ plugin: MarketplacePlugin; release: MarketplaceRelease }>
  ): Promise<boolean> {
    const repository = repositoryParts(input.release.resolvedRepositoryUrl)
    if (!repository) return false
    const tree = await this.#getJson<{ truncated?: boolean; tree?: readonly GithubTreeEntry[] }>(
      `https://api.github.com/repos/${repository.owner}/${repository.name}/git/trees/${input.release.resolvedCommitSha}?recursive=1`
    )
    if (tree.truncated || !Array.isArray(tree.tree)) return false
    const prefix = normalizePath(input.release.pluginSubdirectory)
    if (prefix === undefined) return false
    const files = new Map<string, Uint8Array>()
    let totalBytes = 0
    for (const entry of tree.tree) {
      if (!entry.path) continue
      const relativePath =
        prefix === ''
          ? entry.path
          : entry.path.startsWith(`${prefix}/`)
            ? entry.path.slice(prefix.length + 1)
            : undefined
      if (relativePath === undefined) continue
      // GitHub includes directory nodes in recursive trees; only blobs are
      // content-addressed. Symlinks inside the selected release are rejected.
      if (entry.type === 'tree') continue
      if (!safeRelativePath(relativePath)) return false
      if (entry.mode === '120000' || entry.type !== 'blob' || !entry.sha) return false
      if (files.size >= this.#maxFiles || (entry.size ?? 0) > this.#maxBytes) return false
      const blob = await this.#getJson<{ content?: string; encoding?: string }>(
        `https://api.github.com/repos/${repository.owner}/${repository.name}/git/blobs/${entry.sha}`
      )
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') return false
      const encoded = blob.content.replace(/\s+/gu, '')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.toString('base64') !== encoded) return false
      totalBytes += bytes.byteLength
      if (totalBytes > this.#maxBytes) return false
      files.set(relativePath, new Uint8Array(bytes))
    }
    const expectedPaths = [...input.release.fileIndex].toSorted()
    const actualPaths = [...files.keys()].toSorted()
    if (
      expectedPaths.length !== actualPaths.length ||
      expectedPaths.some((path, index) => path !== actualPaths[index])
    )
      return false
    return bytesDigest(files) === input.release.canonicalContentDigest
  }

  async #getJson<T>(url: string): Promise<T> {
    const response = await this.#fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
      },
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    })
    if (!response.ok) throw new Error('GitHub release fetch failed')
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > this.#maxResponseBytes)
      throw new Error('GitHub release response exceeds size limit')
    return JSON.parse(body) as T
  }
}

function repositoryParts(value: string): { name: string; owner: string } | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined
    const parts = url.pathname
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/u, '')
      .split('/')
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part)))
      return undefined
    const [owner, name] = parts
    if (!owner || !name) return undefined
    return { name, owner }
  } catch {
    return undefined
  }
}

function normalizePath(value: string): string | undefined {
  // Collapse repeated separators without a backtracking regexp. The value is
  // repository-controlled metadata, but keeping this linear also protects the
  // verifier when a malformed archive entry contains a very long separator run.
  const normalized = value
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/')
  if (normalized === '' || normalized === '.') return ''
  return safeRelativePath(normalized) ? normalized : undefined
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}

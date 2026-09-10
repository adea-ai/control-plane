import { createHash } from 'node:crypto'
import { ServiceUnavailableException } from '@nestjs/common'

export const marketplaceArtifactNames = [
  'catalog.v1.json',
  'catalog-latest.v1.json',
  'catalog-summary.v1.json',
  'categories.v1.json',
  'compatibility.v1.json',
  'integrity.json',
  'sources.lock.json',
] as const

const integrityArtifactNames = [
  'catalog.v1.json',
  'catalog-summary.v1.json',
  'categories.v1.json',
  'compatibility.v1.json',
  'sources.lock.json',
] as const

type JsonObject = Record<string, unknown>

export type MarketplaceArtifacts = Readonly<{
  [K in (typeof marketplaceArtifactNames)[number]]: string
}>

export type MarketplaceRelease = Readonly<{
  releaseId: string
  canonicalContentDigest: string
  contentResolution: 'complete' | 'metadata-only'
  requiredConnectors: readonly string[]
  requiredCredentials: readonly string[]
  resolvedRepositoryUrl: string
  resolvedCommitSha: string
  pluginSubdirectory: string
  fileIndex: readonly string[]
  [key: string]: unknown
}>

export type MarketplacePlugin = Readonly<{
  pluginId: string
  displayName: string
  description: string
  sourceId: string
  productGroupingKey: string
  currentReleaseId: string
  availableReleases: readonly MarketplaceRelease[]
  harnessCompatibility: JsonObject
  securityClassification: JsonObject
  provenance: JsonObject
  [key: string]: unknown
}>

export type MarketplaceCatalog = Readonly<{
  schemaVersion: 1
  catalogId: string
  generatedAt: string
  sources: readonly JsonObject[]
  plugins: readonly MarketplacePlugin[]
}>

export type MarketplaceCatalogSnapshot = Readonly<{
  catalog: MarketplaceCatalog
  catalogId: string
  releaseId: string
  artifacts: MarketplaceArtifacts
  state: 'ready' | 'stale'
}>

export interface MarketplaceReleaseVerifier {
  verify(
    input: Readonly<{ plugin: MarketplacePlugin; release: MarketplaceRelease }>
  ): Promise<boolean>
}

export type MarketplaceRegistryServiceOptions = Readonly<{
  fetchImpl?: typeof fetch
  immutableReleaseBaseUrl?: string
  latestUrl?: string
  token?: string
  releaseVerifier?: MarketplaceReleaseVerifier
  requestTimeoutMs?: number
  maxArtifactBytes?: number
}>

export class MarketplaceRegistryError extends Error {
  constructor(
    readonly code:
      | 'MARKETPLACE_CATALOG_VERIFICATION_FAILED'
      | 'MARKETPLACE_REGISTRY_UNAVAILABLE'
      | 'MARKETPLACE_RELEASE_UNAVAILABLE',
    message: string
  ) {
    super(message)
    this.name = 'MarketplaceRegistryError'
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined)
      throw new MarketplaceRegistryError(
        'MARKETPLACE_CATALOG_VERIFICATION_FAILED',
        'Catalog contains an unsupported JSON value'
      )
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as JsonObject
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

export function bytesDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash('sha256')
  for (const [path, bytes] of [...files.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right)
  )) {
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`)
    hash.update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

export class MarketplaceRegistryService {
  readonly #fetchImpl: typeof fetch
  readonly #immutableReleaseBaseUrl: string | undefined
  readonly #latestUrl: string
  readonly #token: string | undefined
  readonly #releaseVerifier: MarketplaceReleaseVerifier | undefined
  readonly #requestTimeoutMs: number
  readonly #maxArtifactBytes: number
  #cache: MarketplaceCatalogSnapshot | undefined

  constructor(options: MarketplaceRegistryServiceOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#immutableReleaseBaseUrl = options.immutableReleaseBaseUrl
    this.#latestUrl =
      options.latestUrl ??
      'https://github.com/adea-ai/plugins/releases/latest/download/catalog-latest.v1.json'
    this.#token = options.token
    this.#releaseVerifier = options.releaseVerifier
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.#maxArtifactBytes = options.maxArtifactBytes ?? 12 * 1024 * 1024
  }

  async getCatalog(): Promise<MarketplaceCatalogSnapshot> {
    try {
      const latestText = await this.#fetchArtifact(this.#latestUrl)
      const latest = parseCatalog(parseJson(latestText, 'catalog-latest.v1.json'))
      const artifacts = await this.#fetchImmutableArtifacts(latest.catalogId)
      const snapshot = verifyArtifacts(artifacts)
      if (snapshot.catalogId !== latest.catalogId)
        throw verificationError('Latest catalog pointer changed during refresh')
      this.#cache = snapshot
      return snapshot
    } catch (error) {
      if (
        error instanceof MarketplaceRegistryError &&
        error.code === 'MARKETPLACE_CATALOG_VERIFICATION_FAILED'
      )
        throw error
      if (this.#cache) return { ...this.#cache, state: 'stale' }
      throw new ServiceUnavailableException({
        code: 'MARKETPLACE_REGISTRY_UNAVAILABLE',
        message: 'The marketplace registry is unavailable',
      })
    }
  }

  async verifyRelease(plugin: MarketplacePlugin, release: MarketplaceRelease): Promise<boolean> {
    if (release.contentResolution !== 'complete' || this.#releaseVerifier === undefined)
      return false
    try {
      return await this.#releaseVerifier.verify({ plugin, release })
    } catch {
      return false
    }
  }

  async #fetchImmutableArtifacts(catalogId: string): Promise<MarketplaceArtifacts> {
    const match = /^catalog:([a-f0-9]{64})$/.exec(catalogId)
    if (!match) throw verificationError('Catalog ID is invalid')
    const suffix = match[1]
    if (!suffix) throw verificationError('Catalog ID is invalid')
    const artifacts = {} as Record<(typeof marketplaceArtifactNames)[number], string>
    for (const name of marketplaceArtifactNames) {
      const url = this.#immutableUrl(suffix, name)
      artifacts[name] = await this.#fetchArtifact(url)
    }
    return artifacts
  }

  #immutableUrl(suffix: string, name: (typeof marketplaceArtifactNames)[number]): string {
    if (this.#immutableReleaseBaseUrl) {
      return `${this.#immutableReleaseBaseUrl.replace(/\/$/u, '').replace('{catalogId}', suffix)}/${name}`
    }
    let latest: URL
    try {
      latest = new URL(this.#latestUrl)
    } catch {
      throw new MarketplaceRegistryError(
        'MARKETPLACE_REGISTRY_UNAVAILABLE',
        'Marketplace registry URL is invalid'
      )
    }
    if (latest.protocol !== 'https:')
      throw new MarketplaceRegistryError(
        'MARKETPLACE_REGISTRY_UNAVAILABLE',
        'Marketplace registry URL must use HTTPS'
      )
    const marker = '/releases/latest/download/catalog-latest.v1.json'
    if (!latest.pathname.endsWith(marker))
      throw new MarketplaceRegistryError(
        'MARKETPLACE_REGISTRY_UNAVAILABLE',
        'An immutable marketplace release URL is required'
      )
    latest.pathname = `${latest.pathname.slice(0, -marker.length)}/releases/download/catalog/${suffix}/${name}`
    latest.search = ''
    latest.hash = ''
    return latest.toString()
  }

  async #fetchArtifact(url: string): Promise<string> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new MarketplaceRegistryError(
        'MARKETPLACE_REGISTRY_UNAVAILABLE',
        'Marketplace artifact URL is invalid'
      )
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new MarketplaceRegistryError(
        'MARKETPLACE_REGISTRY_UNAVAILABLE',
        'Marketplace artifacts must be fetched over HTTPS'
      )
    try {
      const response = await this.#fetchImpl(parsed, {
        headers: {
          Accept: 'application/json',
          ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
        },
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      })
      if (!response.ok) throw new Error('artifact request failed')
      const body = await response.text()
      if (new TextEncoder().encode(body).byteLength > this.#maxArtifactBytes)
        throw new Error('artifact response exceeds size limit')
      return body
    } catch {
      throw new MarketplaceRegistryError(
        'MARKETPLACE_REGISTRY_UNAVAILABLE',
        'Marketplace registry fetch failed'
      )
    }
  }
}

export class UnavailableMarketplaceRegistryService {
  async getCatalog(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'MARKETPLACE_REGISTRY_NOT_CONFIGURED',
      message: 'The marketplace registry is not configured',
    })
  }

  async verifyRelease(): Promise<boolean> {
    return false
  }
}

export function verifyArtifacts(artifacts: MarketplaceArtifacts): MarketplaceCatalogSnapshot {
  const catalog = parseCatalog(parseJson(artifacts['catalog.v1.json'], 'catalog.v1.json'))
  const summary = requireObject(
    parseJson(artifacts['catalog-summary.v1.json'], 'catalog-summary.v1.json')
  ) as JsonObject & { catalogId?: unknown; pluginCount?: unknown; schemaVersion?: unknown }
  const categories = requireObject(
    parseJson(artifacts['categories.v1.json'], 'categories.v1.json')
  ) as JsonObject & { catalogId?: unknown; categories?: unknown; schemaVersion?: unknown }
  const compatibility = requireObject(
    parseJson(artifacts['compatibility.v1.json'], 'compatibility.v1.json')
  ) as JsonObject & { catalogId?: unknown; plugins?: unknown; schemaVersion?: unknown }
  const lock = requireObject(
    parseJson(artifacts['sources.lock.json'], 'sources.lock.json')
  ) as JsonObject & { schemaVersion?: unknown }
  const integrity = requireObject(parseJson(artifacts['integrity.json'], 'integrity.json')) as {
    catalogId?: unknown
    files?: unknown
    schemaVersion?: unknown
  }
  if (
    integrity.schemaVersion !== 1 ||
    integrity.catalogId !== catalog.catalogId ||
    !isStringRecord(integrity.files)
  )
    throw verificationError('Marketplace integrity metadata is invalid')
  if (
    summary.schemaVersion !== 1 ||
    summary.catalogId !== catalog.catalogId ||
    summary.pluginCount !== catalog.plugins.length ||
    categories.schemaVersion !== 1 ||
    categories.catalogId !== catalog.catalogId ||
    !Array.isArray(categories.categories) ||
    compatibility.schemaVersion !== 1 ||
    compatibility.catalogId !== catalog.catalogId ||
    !Array.isArray(compatibility.plugins) ||
    lock.schemaVersion !== 1
  )
    throw verificationError('Marketplace artifact metadata does not match the catalog')
  const integrityFiles = isStringRecord(integrity.files) ? integrity.files : undefined
  if (integrityFiles === undefined)
    throw verificationError('Marketplace integrity file set is invalid')
  const integrityKeys = Object.keys(integrityFiles).toSorted()
  if (
    integrityKeys.length !== integrityArtifactNames.length ||
    integrityKeys.join('|') !== [...integrityArtifactNames].toSorted().join('|')
  )
    throw verificationError('Marketplace integrity file set is invalid')
  for (const name of integrityArtifactNames) {
    if (digest(artifacts[name]) !== integrityFiles[name])
      throw verificationError(`Marketplace artifact digest mismatch: ${name}`)
  }
  if (artifacts['catalog-latest.v1.json'] !== artifacts['catalog.v1.json'])
    throw verificationError('Marketplace latest pointer is not byte-identical')
  const body = Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== 'catalogId'))
  if (`catalog:${digest(body).slice('sha256:'.length)}` !== catalog.catalogId)
    throw verificationError('Marketplace catalogId does not match its canonical body')
  return {
    artifacts,
    catalog,
    catalogId: catalog.catalogId,
    releaseId: catalog.catalogId,
    state: 'ready',
  }
}

export function parseCatalog(value: unknown): MarketplaceCatalog {
  const candidate = requireObject(value) as JsonObject & {
    catalogId?: unknown
    generatedAt?: unknown
    plugins?: unknown
    schemaVersion?: unknown
    sources?: unknown
  }
  if (
    candidate.schemaVersion !== 1 ||
    !/^catalog:[a-f0-9]{64}$/.test(stringValue(candidate.catalogId)) ||
    !timestamp(candidate.generatedAt) ||
    !Array.isArray(candidate.sources) ||
    !Array.isArray(candidate.plugins)
  )
    throw verificationError('Marketplace catalog schema is invalid')
  const plugins = candidate.plugins.map((pluginValue, index) => parsePlugin(pluginValue, index))
  if (new Set(plugins.map((plugin) => plugin.pluginId)).size !== plugins.length)
    throw verificationError('Marketplace catalog contains duplicate plugin IDs')
  return {
    catalogId: stringValue(candidate.catalogId),
    generatedAt: stringValue(candidate.generatedAt),
    plugins,
    schemaVersion: 1,
    sources: candidate.sources.map((source) => requireObject(source)),
  }
}

function parsePlugin(value: unknown, index: number): MarketplacePlugin {
  const plugin = requireObject(value) as JsonObject & {
    description: string
    displayName: string
    availableReleases: readonly unknown[]
    currentReleaseId: string
    harnessCompatibility: JsonObject
    pluginId: string
    productGroupingKey: string
    provenance?: unknown
    securityClassification?: unknown
    sourceId: string
    [key: string]: unknown
  }
  if (
    !/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/.test(stringValue(plugin.pluginId)) ||
    !stringValue(plugin.sourceId) ||
    !/^release:[a-f0-9]{64}$/.test(stringValue(plugin.currentReleaseId)) ||
    !Array.isArray(plugin.availableReleases) ||
    !isObject(plugin.harnessCompatibility) ||
    !isObject(plugin.securityClassification) ||
    !isObject(plugin.provenance)
  )
    throw verificationError(`Marketplace plugin schema is invalid: ${index}`)
  const releases = plugin.availableReleases.map((release, releaseIndex) =>
    parseRelease(release, `${index}.${releaseIndex}`)
  )
  if (!releases.some((release) => release.releaseId === plugin.currentReleaseId))
    throw verificationError(`Marketplace current release is invalid: ${plugin.pluginId}`)
  return {
    ...plugin,
    availableReleases: releases,
    pluginId: plugin.pluginId,
    sourceId: plugin.sourceId,
    currentReleaseId: plugin.currentReleaseId,
    harnessCompatibility: plugin.harnessCompatibility,
    securityClassification: plugin.securityClassification,
    provenance: plugin.provenance,
  } as MarketplacePlugin
}

function parseRelease(value: unknown, index: string): MarketplaceRelease {
  const release = requireObject(value) as {
    canonicalContentDigest?: unknown
    contentResolution?: unknown
    fileIndex?: unknown
    pluginSubdirectory?: unknown
    releaseId?: unknown
    requiredConnectors?: unknown
    requiredCredentials?: unknown
    resolvedCommitSha?: unknown
    resolvedRepositoryUrl?: unknown
    [key: string]: unknown
  }
  if (
    !/^release:[a-f0-9]{64}$/.test(stringValue(release.releaseId)) ||
    !/^sha256:[a-f0-9]{64}$/.test(stringValue(release.canonicalContentDigest)) ||
    !['complete', 'metadata-only'].includes(stringValue(release.contentResolution)) ||
    !Array.isArray(release.requiredConnectors) ||
    !Array.isArray(release.requiredCredentials) ||
    !stringValue(release.resolvedRepositoryUrl) ||
    !/^[a-f0-9]{40}$/.test(stringValue(release.resolvedCommitSha)) ||
    !stringValue(release.pluginSubdirectory) ||
    !Array.isArray(release.fileIndex) ||
    !release.fileIndex.every(isString)
  )
    throw verificationError(`Marketplace release schema is invalid: ${index}`)
  return {
    ...release,
    releaseId: release.releaseId,
    canonicalContentDigest: release.canonicalContentDigest,
    contentResolution: release.contentResolution,
    requiredConnectors: release.requiredConnectors.filter(isString),
    requiredCredentials: release.requiredCredentials.filter(isString),
    resolvedRepositoryUrl: release.resolvedRepositoryUrl,
    resolvedCommitSha: release.resolvedCommitSha,
    pluginSubdirectory: release.pluginSubdirectory,
    fileIndex: release.fileIndex,
  } as MarketplaceRelease
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw verificationError(`Marketplace artifact is not JSON: ${name}`)
  }
}

function requireObject(value: unknown): JsonObject {
  if (!isObject(value)) throw verificationError('Marketplace artifact must be an object')
  return value
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(isString)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function verificationError(message: string): MarketplaceRegistryError {
  return new MarketplaceRegistryError('MARKETPLACE_CATALOG_VERIFICATION_FAILED', message)
}

import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { StructuredLogger } from '@control-plane/bootstrap'
import type { InstallationPlan } from './agent-plugins.js'
import {
  assertMarketplacePlanRequest,
  createMarketplaceAgentPluginsPlan,
  type MarketplaceHarnessProfileAuthority,
} from './agent-plugins.js'
import type {
  MarketplacePlugin,
  MarketplaceRegistryService,
  MarketplaceRelease,
} from './registry.js'

export const marketplaceInstallationStates = [
  'pending-authorization',
  'unavailable',
  'rejected-by-policy',
  'installed',
  'superseded',
] as const

export type MarketplaceInstallationState = (typeof marketplaceInstallationStates)[number]

/**
 * Lifecycle state exposed by the installation get/uninstall operations: the
 * recorded install decision, or the terminal `uninstalled` state once an
 * uninstall has been recorded. The persisted `state` keeps the original install
 * decision so an install replay can return its original result.
 */
export type MarketplaceInstallationLifecycleState = MarketplaceInstallationState | 'uninstalled'

export type MarketplaceWorkspaceIdentity = Readonly<{
  workspaceId: string
  userId: string
}>

export type MarketplaceInstallationRecord = Readonly<{
  installationId: string
  catalogId: string
  workspaceId: string
  userId: string
  pluginId: string
  releaseId: string
  canonicalContentDigest: string
  requestedHarness: string
  installationInstanceId?: string
  packageDigest?: string
  requiredConnectors: readonly string[]
  requiredCredentials: readonly string[]
  state: MarketplaceInstallationState
  idempotencyKey: string
  requestDigest: string
  createdAt: string
  updatedAt: string
  // Recorded together by the one uninstall transition; absent while active.
  uninstalledAt?: string
  uninstalledBy?: string
  uninstallIdempotencyKey?: string
  uninstallRequestDigest?: string
}>

export type MarketplaceInstallationListOptions = Readonly<{ installedBy?: string }>

export type MarketplaceUninstallTransition = Readonly<{
  workspaceId: string
  installationId: string
  uninstalledAt: string
  uninstalledBy: string
  idempotencyKey: string
  requestDigest: string
}>

export interface MarketplaceInstallationRepository {
  findByIdempotency(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<MarketplaceInstallationRecord | undefined>
  /** Exact lookup inside one workspace; another workspace's id is not found. */
  findById(
    workspaceId: string,
    installationId: string
  ): Promise<MarketplaceInstallationRecord | undefined>
  findByUninstallIdempotency(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<MarketplaceInstallationRecord | undefined>
  /** Active (not uninstalled) installations, optionally for one installer. */
  listByWorkspace(
    workspaceId: string,
    options?: MarketplaceInstallationListOptions
  ): Promise<readonly MarketplaceInstallationRecord[]>
  save(record: MarketplaceInstallationRecord): Promise<MarketplaceInstallationRecord>
  /**
   * Records the terminal uninstall transition only while the installation is
   * still active. Returns the updated record, or undefined when nothing changed
   * (unknown id, already uninstalled, or the uninstall key is already taken).
   */
  markUninstalled(
    transition: MarketplaceUninstallTransition
  ): Promise<MarketplaceInstallationRecord | undefined>
}

export type MarketplaceInstallationView = Readonly<{
  installationId: string
  catalogId: string
  pluginId: string
  releaseId: string
  canonicalContentDigest: string
  requestedHarness: string
  installationInstanceId?: string
  packageDigest?: string
  state: MarketplaceInstallationLifecycleState
  installedBy: string
  installedAt: string
  updatedAt: string
  uninstalledBy?: string
  uninstalledAt?: string
}>

export type MarketplaceUninstallResult = Readonly<{
  installation: MarketplaceInstallationView
  replayed: boolean
}>

export interface MarketplaceInstallationAuthority {
  list(
    workspaceId: string,
    options?: MarketplaceInstallationListOptions
  ): Promise<readonly MarketplaceInstallationRecord[]>
  install(envelope: MarketplaceInstallEnvelope): Promise<MarketplaceInstallationRecord>
  plan?(envelope: MarketplaceInstallPlanEnvelope): Promise<InstallationPlan>
  get?(envelope: MarketplaceInstallationGetEnvelope): Promise<MarketplaceInstallationView>
  uninstall?(envelope: MarketplaceUninstallEnvelope): Promise<MarketplaceUninstallResult>
}

export class InMemoryMarketplaceInstallationRepository implements MarketplaceInstallationRepository {
  readonly #records = new Map<string, MarketplaceInstallationRecord>()

  async findByIdempotency(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<MarketplaceInstallationRecord | undefined> {
    return this.#records.get(`${workspaceId}:${idempotencyKey}`)
  }

  async findById(
    workspaceId: string,
    installationId: string
  ): Promise<MarketplaceInstallationRecord | undefined> {
    return [...this.#records.values()].find(
      (record) => record.workspaceId === workspaceId && record.installationId === installationId
    )
  }

  async findByUninstallIdempotency(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<MarketplaceInstallationRecord | undefined> {
    return [...this.#records.values()].find(
      (record) =>
        record.workspaceId === workspaceId && record.uninstallIdempotencyKey === idempotencyKey
    )
  }

  async listByWorkspace(
    workspaceId: string,
    options: MarketplaceInstallationListOptions = {}
  ): Promise<readonly MarketplaceInstallationRecord[]> {
    return [...this.#records.values()].filter(
      (record) =>
        record.workspaceId === workspaceId &&
        record.uninstalledAt === undefined &&
        (options.installedBy === undefined || record.userId === options.installedBy)
    )
  }

  async save(record: MarketplaceInstallationRecord): Promise<MarketplaceInstallationRecord> {
    const key = `${record.workspaceId}:${record.idempotencyKey}`
    const existing = this.#records.get(key)
    if (existing) return existing
    this.#records.set(key, record)
    return record
  }

  async markUninstalled(
    transition: MarketplaceUninstallTransition
  ): Promise<MarketplaceInstallationRecord | undefined> {
    const current = await this.findById(transition.workspaceId, transition.installationId)
    if (!current || current.uninstalledAt !== undefined) return undefined
    if (await this.findByUninstallIdempotency(transition.workspaceId, transition.idempotencyKey))
      return undefined
    const updated: MarketplaceInstallationRecord = {
      ...current,
      uninstallIdempotencyKey: transition.idempotencyKey,
      uninstallRequestDigest: transition.requestDigest,
      uninstalledAt: transition.uninstalledAt,
      uninstalledBy: transition.uninstalledBy,
      updatedAt: transition.uninstalledAt,
    }
    this.#records.set(`${current.workspaceId}:${current.idempotencyKey}`, updated)
    return updated
  }
}

export interface MarketplacePolicyAuthorities {
  authorizeWorkspace?(
    input: Readonly<{
      identity: MarketplaceWorkspaceIdentity
      plugin: MarketplacePlugin
      release: MarketplaceRelease
    }>
  ): Promise<boolean>
  authorizeSecurityClassification?(
    input: Readonly<{
      identity: MarketplaceWorkspaceIdentity
      classification: Readonly<Record<string, unknown>>
    }>
  ): Promise<boolean>
  isRevoked?(
    input: Readonly<{ pluginId: string; releaseId: string; canonicalContentDigest: string }>
  ): Promise<boolean>
  isSuperseded?(input: Readonly<{ pluginId: string; releaseId: string }>): Promise<boolean>
  resolveConnectors?(
    input: Readonly<{ identity: MarketplaceWorkspaceIdentity; names: readonly string[] }>
  ): Promise<Readonly<{ available: boolean }>>
  resolveCredentials?(
    input: Readonly<{ identity: MarketplaceWorkspaceIdentity; names: readonly string[] }>
  ): Promise<Readonly<{ available: boolean }>>
}

export type MarketplaceInstallEnvelope = Readonly<{
  workspaceId: string
  payload: Readonly<{
    pluginId: string
    releaseId: string
    canonicalContentDigest: string
    requestedHarness: string
    installationInstanceId?: string
    workspaceIdentity: MarketplaceWorkspaceIdentity
  }>
  idempotencyKey: string
}>

export type MarketplaceInstallationGetEnvelope = Readonly<{
  workspaceId: string
  parameters: Readonly<{
    installationId: string
    workspaceIdentity: MarketplaceWorkspaceIdentity
  }>
}>

export type MarketplaceUninstallEnvelope = Readonly<{
  workspaceId: string
  idempotencyKey: string
  payload: Readonly<{
    installationId: string
    workspaceIdentity: MarketplaceWorkspaceIdentity
  }>
}>

export type MarketplaceInstallationAuditEvent =
  | 'marketplace.installation.recorded'
  | 'marketplace.installation.uninstalled'

export type MarketplaceInstallPlanEnvelope = Readonly<{
  workspaceId: string
  payload: Readonly<{
    pluginId: string
    releaseId: string
    instanceId: string
    requestedHarness: string
    workspaceIdentity: MarketplaceWorkspaceIdentity
  }>
}>

@Injectable()
export class MarketplaceInstallationService {
  readonly #registry: MarketplaceRegistryService
  readonly #repository: MarketplaceInstallationRepository
  readonly #policy: MarketplacePolicyAuthorities & {
    harnessProfile?: MarketplaceHarnessProfileAuthority
  }
  readonly #now: () => string
  readonly #logger: StructuredLogger | undefined

  constructor(
    options: Readonly<{
      registry: MarketplaceRegistryService
      repository: MarketplaceInstallationRepository
      policy?: MarketplacePolicyAuthorities & {
        harnessProfile?: MarketplaceHarnessProfileAuthority
      }
      now?: () => string
      /** Receives the installation audit events; omitted, none are emitted. */
      logger?: StructuredLogger
    }>
  ) {
    this.#registry = options.registry
    this.#repository = options.repository
    this.#policy = options.policy ?? {}
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#logger = options.logger
  }

  async list(
    workspaceId: string,
    options: MarketplaceInstallationListOptions = {}
  ): Promise<readonly MarketplaceInstallationRecord[]> {
    return this.#repository.listByWorkspace(
      workspaceId,
      options.installedBy === undefined ? {} : { installedBy: options.installedBy }
    )
  }

  async get(envelope: MarketplaceInstallationGetEnvelope): Promise<MarketplaceInstallationView> {
    const { installationId, workspaceIdentity } = parseInstallationReference(
      envelope,
      envelope?.parameters
    )
    const record = await this.#repository.findById(workspaceIdentity.workspaceId, installationId)
    if (!record) installationNotFound()
    return marketplaceInstallationView(record)
  }

  async uninstall(envelope: MarketplaceUninstallEnvelope): Promise<MarketplaceUninstallResult> {
    const { installationId, workspaceIdentity } = parseInstallationReference(
      envelope,
      envelope?.payload
    )
    const idempotencyKey = stringValue(envelope.idempotencyKey)
    if (!idempotencyKey || idempotencyKey.length > 128) invalidRequest('uninstallation')
    const workspaceId = workspaceIdentity.workspaceId
    const requestDigest = digest({ installationId, workspaceIdentity })
    const replay = await this.#uninstallReplay(workspaceId, idempotencyKey, requestDigest)
    if (replay) return replay
    const current = await this.#repository.findById(workspaceId, installationId)
    if (!current) installationNotFound()
    if (current.uninstalledAt !== undefined)
      return { installation: marketplaceInstallationView(current), replayed: true }
    const uninstalledAt = this.#now()
    const updated = await this.#repository.markUninstalled({
      idempotencyKey,
      installationId,
      requestDigest,
      uninstalledAt,
      uninstalledBy: workspaceIdentity.userId,
      workspaceId,
    })
    if (!updated) {
      // A concurrent uninstall won the transition or claimed this key first.
      const raced = await this.#uninstallReplay(workspaceId, idempotencyKey, requestDigest)
      if (raced) return raced
      const latest = await this.#repository.findById(workspaceId, installationId)
      if (!latest) installationNotFound()
      if (latest.uninstalledAt === undefined)
        throw new ConflictException({
          code: 'MARKETPLACE_INSTALLATION_CONFLICT',
          message: 'The marketplace installation changed during uninstallation; retry',
        })
      return { installation: marketplaceInstallationView(latest), replayed: true }
    }
    this.#audit('marketplace.installation.uninstalled', updated, workspaceIdentity.userId)
    return { installation: marketplaceInstallationView(updated), replayed: false }
  }

  async #uninstallReplay(
    workspaceId: string,
    idempotencyKey: string,
    requestDigest: string
  ): Promise<MarketplaceUninstallResult | undefined> {
    const existing = await this.#repository.findByUninstallIdempotency(workspaceId, idempotencyKey)
    if (!existing) return undefined
    if (existing.uninstallRequestDigest !== requestDigest)
      throw new ConflictException({
        code: 'MARKETPLACE_IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for another marketplace request',
      })
    return { installation: marketplaceInstallationView(existing), replayed: true }
  }

  #audit(
    event: MarketplaceInstallationAuditEvent,
    record: MarketplaceInstallationRecord,
    actorUserId: string
  ): void {
    this.#logger?.write({
      level: 'info',
      event,
      details: {
        actorUserId,
        installationId: record.installationId,
        pluginId: record.pluginId,
        releaseId: record.releaseId,
        state: lifecycleState(record),
        workspaceId: record.workspaceId,
      },
    })
  }

  async plan(envelope: MarketplaceInstallPlanEnvelope): Promise<InstallationPlan> {
    const request = assertMarketplacePlanRequest(envelope)
    const profile = await this.#policy.harnessProfile?.resolve({
      harness: request.requestedHarness,
      userId: request.workspaceIdentity.userId,
      workspaceId: request.workspaceIdentity.workspaceId,
    })
    if (!profile)
      throw new ServiceUnavailableException({
        code: 'MARKETPLACE_HARNESS_PROFILE_UNAVAILABLE',
        message: 'No verified harness profile is available for the requested runtime',
      })
    const snapshot = await this.#registry.getCatalog()
    const plugin = snapshot.catalog.plugins.find(
      (candidate) => candidate.pluginId === request.pluginId
    )
    const release = plugin
      ? plugin.availableReleases.find((candidate) => candidate.releaseId === request.releaseId)
      : undefined
    if (!plugin || !release)
      throw new BadRequestException({
        code: 'MARKETPLACE_RELEASE_NOT_FOUND',
        message: 'The requested marketplace release is not present in the verified catalog',
      })
    if (!(await this.#registry.verifyRelease(plugin, release)))
      throw new ServiceUnavailableException({
        code: 'MARKETPLACE_RELEASE_UNAVAILABLE',
        message: 'The exact marketplace release could not be verified',
      })
    return createMarketplaceAgentPluginsPlan({ snapshot, request, profile })
  }

  async install(envelope: MarketplaceInstallEnvelope): Promise<MarketplaceInstallationRecord> {
    const request = parseEnvelope(envelope)
    const requestDigest = digest({
      canonicalContentDigest: request.payload.canonicalContentDigest,
      pluginId: request.payload.pluginId,
      releaseId: request.payload.releaseId,
      requestedHarness: request.payload.requestedHarness,
      installationInstanceId: request.payload.installationInstanceId,
      workspaceIdentity: request.payload.workspaceIdentity,
    })
    const workspaceId = request.payload.workspaceIdentity.workspaceId
    const existing = await this.#repository.findByIdempotency(workspaceId, request.idempotencyKey)
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new ConflictException({
          code: 'MARKETPLACE_IDEMPOTENCY_CONFLICT',
          message: 'The idempotency key was already used for another marketplace request',
        })
      // The install response cannot represent `uninstalled`, and replaying the
      // original decision would report an installation that no longer exists.
      // A reinstall is a new request under a new idempotency key.
      if (existing.uninstalledAt !== undefined) installationUninstalled()
      return existing
    }
    const snapshot = await this.#registry.getCatalog()
    const plugin = snapshot.catalog.plugins.find(
      (candidate) => candidate.pluginId === request.payload.pluginId
    )
    const release = plugin?.availableReleases.find(
      (candidate) => candidate.releaseId === request.payload.releaseId
    )
    let state: MarketplaceInstallationState = 'unavailable'
    if (snapshot.state === 'ready' && plugin && release)
      state = await this.#stateFor(
        request.payload.workspaceIdentity,
        plugin,
        release,
        request.payload
      )
    const now = this.#now()
    const releasePackageDigest = packageDigestForRelease(release)
    const record: MarketplaceInstallationRecord = {
      canonicalContentDigest: request.payload.canonicalContentDigest,
      catalogId: snapshot.catalogId,
      createdAt: now,
      idempotencyKey: request.idempotencyKey,
      installationId: `ins_${createHash('sha256').update(`${workspaceId}:${request.idempotencyKey}`).digest('hex').slice(0, 26)}`,
      ...(request.payload.installationInstanceId
        ? { installationInstanceId: request.payload.installationInstanceId }
        : {}),
      ...(releasePackageDigest ? { packageDigest: releasePackageDigest } : {}),
      pluginId: request.payload.pluginId,
      releaseId: request.payload.releaseId,
      requestDigest,
      requestedHarness: request.payload.requestedHarness,
      requiredConnectors: release?.requiredConnectors ?? [],
      requiredCredentials: release?.requiredCredentials ?? [],
      state,
      updatedAt: now,
      userId: request.payload.workspaceIdentity.userId,
      workspaceId,
    }
    const saved = await this.#repository.save(record)
    if (saved.requestDigest !== requestDigest)
      throw new ConflictException({
        code: 'MARKETPLACE_IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for another marketplace request',
      })
    if (saved.uninstalledAt !== undefined) installationUninstalled()
    if (saved === record) this.#audit('marketplace.installation.recorded', saved, saved.userId)
    return saved
  }

  async #stateFor(
    identity: MarketplaceWorkspaceIdentity,
    plugin: MarketplacePlugin,
    release: MarketplaceRelease,
    payload: MarketplaceInstallEnvelope['payload']
  ): Promise<MarketplaceInstallationState> {
    if (release.canonicalContentDigest !== payload.canonicalContentDigest)
      return 'rejected-by-policy'
    if (
      plugin.currentReleaseId !== release.releaseId ||
      (await this.#policy.isSuperseded?.({
        pluginId: plugin.pluginId,
        releaseId: release.releaseId,
      }))
    )
      return 'superseded'
    if (
      await this.#policy.isRevoked?.({
        canonicalContentDigest: release.canonicalContentDigest,
        pluginId: plugin.pluginId,
        releaseId: release.releaseId,
      })
    )
      return 'rejected-by-policy'
    if (release.contentResolution !== 'complete') return 'unavailable'
    const compatibility = plugin.harnessCompatibility[payload.requestedHarness]
    if (
      !isObject(compatibility) ||
      ['unsupported', 'blocked', 'blocked-by-policy', 'rejected'].includes(
        stringValue(compatibility['status'])
      )
    )
      return 'rejected-by-policy'
    if (
      this.#policy.authorizeWorkspace &&
      !(await this.#policy.authorizeWorkspace({ identity, plugin, release }))
    )
      return 'rejected-by-policy'
    const securityClassification = stringValue(plugin.securityClassification['level'])
    if (this.#policy.authorizeSecurityClassification) {
      if (
        !(await this.#policy.authorizeSecurityClassification({
          classification: plugin.securityClassification,
          identity,
        }))
      )
        return 'rejected-by-policy'
    } else if (securityClassification !== 'low') {
      return 'rejected-by-policy'
    }
    const connectors = await this.#policy.resolveConnectors?.({
      identity,
      names: release.requiredConnectors,
    })
    const credentials = await this.#policy.resolveCredentials?.({
      identity,
      names: release.requiredCredentials,
    })
    if (release.requiredConnectors.length > 0 && connectors?.available !== true)
      return 'pending-authorization'
    if (release.requiredCredentials.length > 0 && credentials?.available !== true)
      return 'pending-authorization'
    if (!(await this.#registry.verifyRelease(plugin, release))) return 'unavailable'
    return 'installed'
  }
}

@Injectable()
export class UnavailableMarketplaceInstallationService implements MarketplaceInstallationAuthority {
  async list(): Promise<readonly MarketplaceInstallationRecord[]> {
    return []
  }

  async install(): Promise<never> {
    throw new Error('MARKETPLACE_INSTALLATION_NOT_CONFIGURED')
  }

  async get(): Promise<never> {
    installationNotConfigured()
  }

  async uninstall(): Promise<never> {
    installationNotConfigured()
  }

  async plan(): Promise<never> {
    throw new ServiceUnavailableException({
      code: 'MARKETPLACE_INSTALLATION_NOT_CONFIGURED',
      message: 'Marketplace installation planning is not configured',
    })
  }
}

function parseEnvelope(value: MarketplaceInstallEnvelope): MarketplaceInstallEnvelope {
  if (!isObject(value) || !isObject(value.payload) || !isObject(value.payload.workspaceIdentity))
    throw new BadRequestException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation request is invalid',
    })
  const payload = value.payload
  const identity = payload.workspaceIdentity
  if (
    !stringValue(value.workspaceId) ||
    !stringValue(value.idempotencyKey) ||
    !stringValue(payload.pluginId) ||
    !/^release:[a-f0-9]{64}$/.test(stringValue(payload.releaseId)) ||
    !/^sha256:[a-f0-9]{64}$/.test(stringValue(payload.canonicalContentDigest)) ||
    !stringValue(payload.requestedHarness) ||
    (payload.installationInstanceId !== undefined &&
      (!stringValue(payload.installationInstanceId) ||
        payload.installationInstanceId.length > 256)) ||
    !stringValue(identity.workspaceId) ||
    identity.workspaceId !== value.workspaceId ||
    !stringValue(identity.userId)
  )
    throw new BadRequestException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation request is invalid',
    })
  return value
}

export function marketplaceInstallationView(
  record: MarketplaceInstallationRecord
): MarketplaceInstallationView {
  return {
    canonicalContentDigest: record.canonicalContentDigest,
    catalogId: record.catalogId,
    installationId: record.installationId,
    ...(record.installationInstanceId === undefined
      ? {}
      : { installationInstanceId: record.installationInstanceId }),
    installedAt: record.createdAt,
    installedBy: record.userId,
    ...(record.packageDigest === undefined ? {} : { packageDigest: record.packageDigest }),
    pluginId: record.pluginId,
    releaseId: record.releaseId,
    requestedHarness: record.requestedHarness,
    state: lifecycleState(record),
    ...(record.uninstalledAt === undefined || record.uninstalledBy === undefined
      ? {}
      : { uninstalledAt: record.uninstalledAt, uninstalledBy: record.uninstalledBy }),
    updatedAt: record.updatedAt,
  }
}

function lifecycleState(
  record: MarketplaceInstallationRecord
): MarketplaceInstallationLifecycleState {
  return record.uninstalledAt === undefined ? record.state : 'uninstalled'
}

const installationIdPattern = /^ins_[a-z0-9]{1,124}$/

function parseInstallationReference(
  envelope: unknown,
  body: unknown
): Readonly<{ installationId: string; workspaceIdentity: MarketplaceWorkspaceIdentity }> {
  if (!isObject(envelope) || !isObject(body) || !isObject(body['workspaceIdentity']))
    invalidRequest('installation')
  const identity = body['workspaceIdentity'] as Record<string, unknown>
  const workspaceId = stringValue(envelope['workspaceId'])
  const installationId = stringValue(body['installationId'])
  const userId = stringValue(identity['userId'])
  if (
    !workspaceId ||
    stringValue(identity['workspaceId']) !== workspaceId ||
    !userId ||
    userId.length > 128 ||
    !installationIdPattern.test(installationId)
  )
    invalidRequest('installation')
  return { installationId, workspaceIdentity: { userId, workspaceId } }
}

function invalidRequest(subject: 'installation' | 'uninstallation'): never {
  throw new BadRequestException({
    code: 'MARKETPLACE_REQUEST_INVALID',
    message: `Marketplace ${subject} request is invalid`,
  })
}

function installationNotFound(): never {
  // Deliberately identical for an unknown id and another workspace's id.
  throw new NotFoundException({
    code: 'MARKETPLACE_INSTALLATION_NOT_FOUND',
    message: 'The marketplace installation was not found in this workspace',
  })
}

function installationUninstalled(): never {
  throw new ConflictException({
    code: 'MARKETPLACE_INSTALLATION_UNINSTALLED',
    message: 'The marketplace installation was uninstalled; reinstall with a new idempotency key',
  })
}

function installationNotConfigured(): never {
  throw new ServiceUnavailableException({
    code: 'MARKETPLACE_INSTALLATION_NOT_CONFIGURED',
    message: 'Marketplace installation management is not configured',
  })
}

function packageDigestForRelease(release: MarketplaceRelease | undefined): string | undefined {
  if (!release || !isObject(release['releaseMetadata'])) return undefined
  const packageValue = release['releaseMetadata']['agentPlugins']
  if (!isObject(packageValue)) return undefined
  const value = packageValue['packageDigest']
  return /^sha256:[a-f0-9]{64}$/.test(stringValue(value)) ? stringValue(value) : undefined
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

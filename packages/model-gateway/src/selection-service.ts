import { validConnectionUpdate } from './selection-repository.js'
import { randomBytes } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import {
  CredentialVaultError,
  createCredentialLeaseId,
  type CredentialVault,
} from '@control-plane/credential-vault'
import {
  ModelChoiceSchema,
  ModelConnectionSchema,
  ModelExecutionTargetSchema,
  ModelReadinessReasonSchema,
  RuntimeProviderSelectionSchema,
  WorkspaceModelDefaultsSchema,
  type ModelConnection,
  type ModelExecutionTarget,
  type ModelReadinessReason,
  type RuntimeProviderSelection,
  type WorkspaceModelDefaults,
} from './selection.js'

export interface ModelSelectionRepository {
  getConnection(workspaceId: string, connectionRef: string): Promise<ModelConnection | undefined>
  listConnections(workspaceId: string): Promise<readonly ModelConnection[]>
  /** Trusted administration only. API defaults/overrides cannot mint or widen grants. */
  saveConnection(expectedRevision: number, next: ModelConnection): Promise<boolean>
  getDefaults(workspaceId: string): Promise<WorkspaceModelDefaults | undefined>
  saveDefaults(expectedRevision: number, next: WorkspaceModelDefaults): Promise<boolean>
  insertSelection(next: RuntimeProviderSelection): Promise<boolean>
  getSelection(
    workspaceId: string,
    selectionRef: string
  ): Promise<RuntimeProviderSelection | undefined>
}

/** Trusted, exact provider policy/capability/quota evidence supplied by host composition.
 * A caller's requested target is never qualification evidence. Missing evidence denies.
 */
export interface ModelQualification {
  evaluate(input: {
    connection: ModelConnection
    providerModel: string
    target: ModelExecutionTarget
  }): Promise<ModelReadinessReason>
}
export class ModelSelectionError extends Error {
  constructor(readonly code: ModelReadinessReason) {
    super(code)
    this.name = 'ModelSelectionError'
  }
}
const AdmissionInput = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  role: z.enum(['lead', 'child', 'direct']),
  target: ModelExecutionTargetSchema,
  override: ModelChoiceSchema.optional(),
})
const SelectionReference = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  selectionRef: RuntimeProviderSelectionSchema.shape.selectionRef,
  selectionRevision: RuntimeProviderSelectionSchema.shape.selectionRevision,
})

export class ModelSelectionService {
  readonly #repository: ModelSelectionRepository
  readonly #vault: Pick<CredentialVault, 'metadata'> &
    Partial<Pick<CredentialVault, 'lease' | 'use'>>
  readonly #qualification: ModelQualification
  readonly #now: () => string
  constructor(options: {
    repository: ModelSelectionRepository
    vault: Pick<CredentialVault, 'metadata'> & Partial<Pick<CredentialVault, 'lease' | 'use'>>
    qualification: ModelQualification
    now?: () => string
  }) {
    this.#repository = options.repository
    this.#vault = options.vault
    this.#qualification = options.qualification
    this.#now = options.now ?? (() => new Date().toISOString())
  }
  async getDefaults(workspaceId: string) {
    return this.#repository.getDefaults(IdentifierSchemas.workspaceId.parse(workspaceId))
  }
  async setDefaults(expectedRevision: number, input: unknown): Promise<WorkspaceModelDefaults> {
    const parsed = WorkspaceModelDefaultsSchema.safeParse(input)
    if (
      !parsed.success ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      parsed.data.revision !== expectedRevision + 1
    )
      fail('SELECTION_CHANGED')
    const next = parsed.data
    for (const choice of [next.lead, next.child, next.direct]) {
      if (!choice) continue
      const connection = await this.#repository.getConnection(
        next.workspaceId,
        choice.connectionRef
      )
      const reason = await this.#connectionReady(connection, next.workspaceId)
      if (reason !== 'READY') fail(reason)
      if (!connection?.models.includes(choice.providerModel)) fail('MODEL_UNAVAILABLE')
    }
    if (!(await this.#repository.saveDefaults(expectedRevision, next))) fail('SELECTION_CHANGED')
    return structuredClone(next)
  }
  async list(workspaceId: string, targetInput: unknown) {
    const scope = IdentifierSchemas.workspaceId.parse(workspaceId)
    const target = ModelExecutionTargetSchema.parse(targetInput)
    const records = await this.#repository.listConnections(scope)
    return Promise.all(
      records.map(async (connection) => ({
        connection,
        models: await Promise.all(
          connection.models.map(async (providerModel) => {
            const reasonCode = await this.#ready(connection, providerModel, target, scope)
            return { providerModel, readiness: { ready: reasonCode === 'READY', reasonCode } }
          })
        ),
      }))
    )
  }
  async select(input: unknown): Promise<RuntimeProviderSelection> {
    const parsed = AdmissionInput.safeParse(input)
    if (!parsed.success) fail('SELECTION_CHANGED')
    const request = parsed.data
    let defaults = await this.#repository.getDefaults(request.workspaceId)
    if (!defaults && request.override) {
      await this.#repository.saveDefaults(0, { workspaceId: request.workspaceId, revision: 1 })
      defaults = await this.#repository.getDefaults(request.workspaceId)
      if (!defaults) fail('SELECTION_CHANGED')
    }
    const choice = request.override ?? defaults?.[request.role]
    if (!choice) fail('MODEL_UNAVAILABLE')
    const connection = await this.#repository.getConnection(
      request.workspaceId,
      choice.connectionRef
    )
    const reason = await this.#ready(
      connection,
      choice.providerModel,
      request.target,
      request.workspaceId
    )
    if (reason !== 'READY') fail(reason)
    if (!connection) fail('CONNECTION_MISSING')
    const selection = RuntimeProviderSelectionSchema.parse({
      schemaVersion: 'model-selection/v1',
      selectionRef: `msel_${randomBytes(16).toString('hex')}`,
      selectionRevision: 1,
      workspaceId: request.workspaceId,
      connectionRef: connection.connectionRef,
      connectionRevision: connection.revision,
      credentialRef: connection.credentialRef,
      credentialRevision: connection.credentialRevision,
      provider: connection.provider,
      providerModel: choice.providerModel,
      accountRef: connection.accountRef,
      authKind: connection.authKind,
      fundingSource: connection.fundingSource,
      ...request.target,
      workspaceGrant: {
        grantRef: connection.workspaceGrant.grantRef,
        revision: connection.workspaceGrant.revision,
      },
      configurationRevision: defaults?.revision ?? 1,
    })
    if (!(await this.#repository.insertSelection(selection))) fail('SELECTION_CHANGED')
    // Security changes during persistence also block admission.
    await this.assertReady(selection)
    return structuredClone(selection)
  }
  async resolveSelection(input: unknown): Promise<RuntimeProviderSelection> {
    const parsed = SelectionReference.safeParse(input)
    if (!parsed.success) fail('SELECTION_CHANGED')
    const { workspaceId, selectionRef, selectionRevision } = parsed.data
    const selection = await this.#repository.getSelection(workspaceId, selectionRef)
    if (
      !selection ||
      selection.workspaceId !== workspaceId ||
      selection.selectionRevision !== selectionRevision
    )
      fail('SELECTION_CHANGED')
    return RuntimeProviderSelectionSchema.parse(selection)
  }
  async assertReady(input: unknown): Promise<void> {
    const parsed = RuntimeProviderSelectionSchema.safeParse(input)
    if (!parsed.success) fail('SELECTION_CHANGED')
    const selection = parsed.data
    const accepted = await this.resolveSelection({
      workspaceId: selection.workspaceId,
      selectionRef: selection.selectionRef,
      selectionRevision: selection.selectionRevision,
    })
    if (canonicalJsonStringify(selection) !== canonicalJsonStringify(accepted))
      fail('SELECTION_CHANGED')
    const connection = await this.#repository.getConnection(
      selection.workspaceId,
      selection.connectionRef
    )
    const reason = await this.#ready(
      connection,
      selection.providerModel,
      selection,
      selection.workspaceId
    )
    if (reason !== 'READY') fail(reason)
    if (
      !connection ||
      connection.revision !== selection.connectionRevision ||
      connection.credentialRef !== selection.credentialRef ||
      connection.credentialRevision !== selection.credentialRevision ||
      connection.provider !== selection.provider ||
      connection.accountRef !== selection.accountRef ||
      connection.authKind !== selection.authKind ||
      connection.fundingSource !== selection.fundingSource ||
      connection.workspaceGrant.grantRef !== selection.workspaceGrant.grantRef ||
      connection.workspaceGrant.revision !== selection.workspaceGrant.revision
    )
      fail('SELECTION_CHANGED')
  }
  /** In-memory callback only. Existing vault consumes one scoped lease and blocks secret egress. */
  async withCredential<Result>(
    selection: RuntimeProviderSelection,
    authority: {
      requestId: string
      principalRef: string
      policySnapshot: Parameters<CredentialVault['lease']>[0]['policySnapshot']
    },
    operation: (secret: string) => Result | Promise<Result>
  ): Promise<Result> {
    await this.assertReady(selection)
    if (!this.#vault.lease || !this.#vault.use) fail('READINESS_UNAVAILABLE')
    if (selection.authKind !== 'api_key') fail('AUTH_MODE_UNSUPPORTED')
    const requestedAt = this.#now()
    const metadata = await this.#vault.metadata(selection.credentialRef, selection.workspaceId)
    const expiresAt = new Date(
      Math.min(
        Date.parse(requestedAt) + 60_000,
        metadata.expiresAt ? Date.parse(metadata.expiresAt) : Infinity
      )
    ).toISOString()
    try {
      const lease = await this.#vault.lease({
        credentialLeaseId: createCredentialLeaseId(),
        credentialId: selection.credentialRef,
        requestId: authority.requestId,
        workspaceId: selection.workspaceId,
        principalRef: authority.principalRef,
        operation: 'model:invoke',
        resourceRef: selection.selectionRef,
        requestedAt,
        expiresAt,
        policySnapshot: authority.policySnapshot,
        expectedCredentialRevision: selection.credentialRevision,
      })
      await this.assertReady(selection)
      return await this.#vault.use(
        lease.capabilityRef,
        {
          workspaceId: selection.workspaceId,
          operation: 'model:invoke',
          resourceRef: selection.selectionRef,
        },
        async (secret) => {
          await this.assertReady(selection)
          return safeCredentialResult(await operation(secret))
        }
      )
    } catch (error) {
      if (error instanceof ModelSelectionError) throw error
      if (error instanceof CredentialVaultError) {
        const code = error.code
        if (
          code === 'CREDENTIAL_EXPIRED' ||
          code === 'CREDENTIAL_REVOKED' ||
          code === 'CREDENTIAL_MISSING'
        )
          fail(code)
        if (code === 'CREDENTIAL_REVISION_CONFLICT') fail('CREDENTIAL_REVISION_CHANGED')
        if (code === 'POLICY_DENIED') fail('PROVIDER_POLICY_DENIED')
      }
      fail('READINESS_UNAVAILABLE')
    }
  }
  async #connectionReady(
    connection: ModelConnection | undefined,
    workspaceId: string
  ): Promise<ModelReadinessReason> {
    if (!connection || connection.workspaceId !== workspaceId) return 'CONNECTION_MISSING'
    if (connection.status === 'revoked') return 'CONNECTION_REVOKED'
    if (connection.workspaceGrant.status === 'revoked') return 'WORKSPACE_GRANT_REVOKED'
    const now = Date.parse(this.#now())
    if (!Number.isFinite(now)) return 'READINESS_UNAVAILABLE'
    if (Date.parse(connection.workspaceGrant.expiresAt) <= now) return 'WORKSPACE_GRANT_EXPIRED'
    try {
      const credential = await this.#vault.metadata(connection.credentialRef, workspaceId)
      if (credential.workspaceId !== workspaceId || credential.provider !== connection.provider)
        return 'CREDENTIAL_MISSING'
      if (credential.status === 'revoked') return 'CREDENTIAL_REVOKED'
      if (credential.status === 'expired') return 'CREDENTIAL_EXPIRED'
      if (credential.status !== 'active') return 'CREDENTIAL_MISSING'
      if (credential.revision !== connection.credentialRevision)
        return 'CREDENTIAL_REVISION_CHANGED'
      return 'READY'
    } catch (error) {
      return error instanceof CredentialVaultError && error.code === 'CREDENTIAL_MISSING'
        ? 'CREDENTIAL_MISSING'
        : 'READINESS_UNAVAILABLE'
    }
  }
  async #ready(
    connection: ModelConnection | undefined,
    providerModel: string,
    target: ModelExecutionTarget,
    workspaceId: string
  ): Promise<ModelReadinessReason> {
    const reason = await this.#connectionReady(connection, workspaceId)
    if (reason !== 'READY' || !connection) return reason
    if (!connection.models.includes(providerModel)) return 'MODEL_UNAVAILABLE'
    // This slice's Durable Models bridge supports explicit API keys only.
    // Native subscription/local reuse needs its own supported binding qualification.
    if (target.harness === 'pi_durable' && connection.authKind !== 'api_key')
      return 'AUTH_MODE_UNSUPPORTED'
    try {
      return ModelReadinessReasonSchema.parse(
        await this.#qualification.evaluate({ connection, providerModel, target })
      )
    } catch {
      return 'READINESS_UNAVAILABLE'
    }
  }
}
function fail(code: ModelReadinessReason): never {
  throw new ModelSelectionError(code)
}

/** Copy normalized JSON without invoking accessors or allowing credential-bearing closures. */
function safeCredentialResult<Value>(value: Value): Value {
  const seen = new Set<object>()
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || input === null || seen.has(input))
      fail('READINESS_UNAVAILABLE')
    const array = Array.isArray(input)
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      fail('READINESS_UNAVAILABLE')
    if (Object.getOwnPropertySymbols(input).length) fail('READINESS_UNAVAILABLE')
    if (array) {
      const keys = Object.getOwnPropertyNames(input)
      const length = (input as unknown[]).length
      if (
        keys.length !== length + 1 ||
        keys.some(
          (key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)
        )
      )
        fail('READINESS_UNAVAILABLE')
    }
    seen.add(input)
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor)) fail('READINESS_UNAVAILABLE')
      Object.defineProperty(result, key, {
        value: copy(descriptor.value),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    seen.delete(input)
    return result
  }
  return copy(value) as Value
}

/** Deterministic fixture repository; production must inject durable compare-and-set storage. */
export class InMemoryModelSelectionRepository implements ModelSelectionRepository {
  readonly #connections = new Map<string, ModelConnection>()
  readonly #defaults = new Map<string, WorkspaceModelDefaults>()
  readonly #selections = new Map<string, RuntimeProviderSelection>()
  async getConnection(workspaceId: string, ref: string) {
    return structuredClone(this.#connections.get(`${workspaceId}:${ref}`))
  }
  async listConnections(workspaceId: string) {
    return [...this.#connections.values()]
      .filter((value) => value.workspaceId === workspaceId)
      .map((value) => structuredClone(value))
  }
  async saveConnection(expectedRevision: number, input: ModelConnection) {
    const next = ModelConnectionSchema.parse(input)
    const key = `${next.workspaceId}:${next.connectionRef}`
    const current = this.#connections.get(key)
    if (!validConnectionUpdate(current, expectedRevision, next)) return false
    this.#connections.set(key, structuredClone(next))
    return true
  }
  async getDefaults(workspaceId: string) {
    return structuredClone(this.#defaults.get(workspaceId))
  }
  async saveDefaults(expectedRevision: number, input: WorkspaceModelDefaults) {
    const next = WorkspaceModelDefaultsSchema.parse(input)
    if (
      (this.#defaults.get(next.workspaceId)?.revision ?? 0) !== expectedRevision ||
      next.revision !== expectedRevision + 1
    )
      return false
    this.#defaults.set(next.workspaceId, structuredClone(next))
    return true
  }
  async insertSelection(input: RuntimeProviderSelection) {
    const next = RuntimeProviderSelectionSchema.parse(input)
    const key = `${next.workspaceId}:${next.selectionRef}`
    if (this.#selections.has(key)) return false
    this.#selections.set(key, structuredClone(next))
    return true
  }
  async getSelection(workspaceId: string, ref: string) {
    return structuredClone(this.#selections.get(`${workspaceId}:${ref}`))
  }
}

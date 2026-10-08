import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  ToolGateway,
  toolRequestDigest,
  type DurableToolExecutionOutcome,
  type PreparedToolExecution,
} from '@control-plane/tool-execution'
import { DurableToolCallRequestSchema, type DurableToolCallRequest } from '@control-plane/tool-sdk'

export type DurableEffectGateOutcome =
  | DurableToolExecutionOutcome
  | {
      readonly state: 'reconciliation_required' | 'denied'
      readonly reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN' | 'PI_EFFECT_AUTHORITY_REJECTED'
      readonly toolCallId: string
    }

export interface DurableEffectGateRecord {
  readonly schemaVersion: 'pi-effect-gate/v1'
  readonly key: string
  readonly requestDigest: string
  readonly toolRequestDigest: string
  readonly toolCallId: string
  readonly revision: number
  readonly state: 'invoking' | 'awaiting_approval' | 'settled'
  readonly outcome?: DurableEffectGateOutcome
}

export interface DurableEffectGateStore {
  get(key: string): Promise<DurableEffectGateRecord | undefined>
  insert(record: DurableEffectGateRecord): Promise<boolean>
  compareAndSet(expectedRevision: number, record: DurableEffectGateRecord): Promise<boolean>
}

/** Uses the runtime journal's connection; the caller owns its lifecycle. */
export class SqliteDurableEffectGateStore implements DurableEffectGateStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS pi_effect_gates (
      key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL
    )`)
  }

  async get(key: string): Promise<DurableEffectGateRecord | undefined> {
    const row = this.database.prepare('SELECT record FROM pi_effect_gates WHERE key = ?').get(key)
    return row ? (JSON.parse(String(row['record'])) as DurableEffectGateRecord) : undefined
  }

  async insert(record: DurableEffectGateRecord): Promise<boolean> {
    return (
      this.database
        .prepare('INSERT OR IGNORE INTO pi_effect_gates VALUES (?, ?, ?)')
        .run(record.key, record.revision, JSON.stringify(record)).changes === 1
    )
  }

  async compareAndSet(expectedRevision: number, record: DurableEffectGateRecord): Promise<boolean> {
    return (
      this.database
        .prepare(
          'UPDATE pi_effect_gates SET revision = ?, record = ? WHERE key = ? AND revision = ?'
        )
        .run(record.revision, JSON.stringify(record), record.key, expectedRevision).changes === 1
    )
  }
}

export class PiDurableEffectGateError extends Error {
  constructor(
    readonly code:
      | 'PI_EFFECT_IDENTITY_CONFLICT'
      | 'PI_EFFECT_STORE_CONFLICT'
      | 'PI_EFFECT_AUTHORITY_REJECTED'
  ) {
    super(code)
    this.name = 'PiDurableEffectGateError'
  }
}

/** This gate exposes only the existing governed tool service, never native Pi tools. */
export class PiDurableEffectGate {
  readonly #now: () => string

  constructor(
    readonly options: {
      readonly store: DurableEffectGateStore
      readonly service: PolicyControlledToolExecutionService
      /** Resolves current canonical attempt, immutable plan and budget authority. */
      readonly assertAuthority: (
        request: DurableToolCallRequest,
        boundary: 'admission' | 'approval' | 'effect'
      ) => Promise<void>
      readonly now?: () => string
    }
  ) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async execute(
    input: unknown,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<DurableEffectGateOutcome> {
    const request = DurableToolCallRequestSchema.parse(input)
    const key = JSON.stringify([request.workspaceId, request.idempotencyKey])
    // Bind the ENTIRE validated request: the existing service digest omits grant
    // scope/expiry and approval audience/expiry. Persist no inputs or credentials.
    const requestDigest = `sha256:${createHash('sha256')
      .update(canonicalJsonStringify(request) ?? 'null')
      .digest('hex')}`
    const record = await this.#store(() => this.options.store.get(key))
    if (
      record &&
      (record.schemaVersion !== 'pi-effect-gate/v1' || record.requestDigest !== requestDigest)
    ) {
      throw new PiDurableEffectGateError('PI_EFFECT_IDENTITY_CONFLICT')
    }
    // Retained outcomes remain evidence, but publication requires current canonical authority.
    await this.#assertAuthority(request, 'admission')
    if (record?.state === 'settled' && record.outcome) return record.outcome
    if (record?.state === 'invoking') return unknownOutcome(request)
    const invoking: DurableEffectGateRecord = {
      schemaVersion: 'pi-effect-gate/v1',
      key,
      requestDigest,
      toolRequestDigest: toolRequestDigest(request),
      toolCallId: request.toolCallId,
      revision: (record?.revision ?? 0) + 1,
      state: 'invoking',
    }
    const previousRevision = record?.revision
    const claimed =
      previousRevision !== undefined
        ? await this.#store(() => this.options.store.compareAndSet(previousRevision, invoking))
        : await this.#store(() => this.options.store.insert(invoking))
    if (!claimed) throw new PiDurableEffectGateError('PI_EFFECT_STORE_CONFLICT')
    let authorityRejected = false
    let effectStarted = false
    const guard = async (boundary: 'approval' | 'effect') => {
      try {
        await this.#assertAuthority(request, boundary)
      } catch {
        authorityRejected = true
        throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
      }
    }
    const review = async () => {
      const approval = request.approval
      if (!approval) throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
      await guard('approval')
      if (Date.parse(approval.expiresAt) <= Date.parse(this.#now()))
        return { state: 'expired' as const, interactionId: approval.interactionId }
      const coordinator = this.options.service.approvals
      if (coordinator instanceof InteractionToolApprovalCoordinator) {
        const interaction = await coordinator.repository.get(approval.interactionId)
        if (
          interaction &&
          (interaction.executionId !== request.executionId ||
            interaction.attemptId !== request.attemptId ||
            interaction.kind !== 'approval' ||
            interaction.prompt.detailsReference !== `artifact://tool-call/${request.toolCallId}` ||
            interaction.requestedAt !== approval.requestedAt ||
            interaction.expiresAt !== approval.expiresAt ||
            canonicalJsonStringify(interaction.allowedPrincipalIds.toSorted()) !==
              canonicalJsonStringify(approval.allowedPrincipalIds.toSorted()))
        ) {
          authorityRejected = true
          throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
        }
      }
      // Injected coordinators must resolve canonical records, not user decisions.
      const result = await coordinator.review({
        toolCallId: request.toolCallId,
        interactionId: approval.interactionId,
        executionId: request.executionId,
        attemptId: request.attemptId,
        title: `Approve ${request.operation}`,
        allowedPrincipalIds: approval.allowedPrincipalIds,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
      })
      await guard('approval')
      if (Date.parse(approval.expiresAt) <= Date.parse(this.#now()))
        return { state: 'expired' as const, interactionId: approval.interactionId }
      if (
        result.interactionId !== approval.interactionId ||
        (result.state === 'approved' &&
          (!result.decisionPrincipalRef ||
            !approval.allowedPrincipalIds.includes(result.decisionPrincipalRef)))
      ) {
        authorityRejected = true
        throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
      }
      return result
    }
    const beforeEffect = async (approvalRequired: boolean) => {
      const call = await this.options.service.calls.get(request.toolCallId)
      if ((approvalRequired || call?.policyDecision?.requiresApproval) && !request.approval) {
        authorityRejected = true
        throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
      }
      await guard('effect')
      // Re-review even if a previous service process persisted `authorized`,
      // and after the authority callback's await can expose revocation.
      if (request.approval && (await review()).state !== 'approved') {
        authorityRejected = true
        throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
      }
      if (
        request.grant.expiresAt &&
        Date.parse(request.grant.expiresAt) <= Date.parse(this.#now())
      ) {
        authorityRejected = true
        throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
      }
      effectStarted = true
    }
    const base = this.options.service
    const service = new PolicyControlledToolExecutionService({
      gateway: new AuthorityCheckedGateway(base.gateway, beforeEffect),
      calls: base.calls,
      authorizer: base.authorizer,
      approvals: { review },
      rateLimiter: base.rateLimiter,
      now: base.now,
    })
    let outcome: DurableEffectGateOutcome
    try {
      outcome = await service.execute(request, options)
    } catch {
      // Exceptions are never serialized, and uncertain effects are never retried.
      outcome = unknownOutcome(request)
    }
    if (authorityRejected && !effectStarted) {
      outcome = {
        state: 'denied',
        reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
        toolCallId: request.toolCallId,
      }
    }
    const next: DurableEffectGateRecord = {
      ...invoking,
      revision: invoking.revision + 1,
      state: outcome.state === 'awaiting_approval' ? 'awaiting_approval' : 'settled',
      outcome,
    }
    if (!(await this.#store(() => this.options.store.compareAndSet(invoking.revision, next))))
      throw new PiDurableEffectGateError('PI_EFFECT_STORE_CONFLICT')
    // Keep the receipt even when authority changes while the effect awaits; publication
    // can be denied without losing evidence or admitting the effect again.
    await this.#assertAuthority(request, 'admission')
    return outcome
  }

  async #assertAuthority(
    request: DurableToolCallRequest,
    boundary: 'admission' | 'approval' | 'effect'
  ): Promise<void> {
    try {
      await this.options.assertAuthority(structuredClone(request), boundary)
    } catch {
      throw new PiDurableEffectGateError('PI_EFFECT_AUTHORITY_REJECTED')
    }
  }

  async #store<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
      return await operation()
    } catch {
      throw new PiDurableEffectGateError('PI_EFFECT_STORE_CONFLICT')
    }
  }
}

class AuthorityCheckedGateway extends ToolGateway {
  constructor(
    readonly delegate: ToolGateway,
    readonly beforeEffect: (approvalRequired: boolean) => Promise<void>
  ) {
    super(delegate.registry)
  }

  override async prepare(input: unknown): Promise<PreparedToolExecution> {
    const prepared = await this.delegate.prepare(input)
    const executor = prepared.executor
    return {
      ...prepared,
      executor: {
        execute: async (request, version, signal) => {
          await this.beforeEffect(prepared.operation.approvalMode === 'always')
          return executor.execute(request, version, signal)
        },
      },
    }
  }

  override async invoke(
    prepared: PreparedToolExecution,
    options: { readonly signal?: AbortSignal } = {}
  ) {
    return this.delegate.invoke(prepared, options)
  }
}

function unknownOutcome(request: DurableToolCallRequest): DurableEffectGateOutcome {
  return {
    state: 'reconciliation_required',
    reasonCode: 'PI_EFFECT_OUTCOME_UNKNOWN',
    toolCallId: request.toolCallId,
  }
}

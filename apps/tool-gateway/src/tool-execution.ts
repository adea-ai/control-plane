import { createHash } from 'node:crypto'
import { type InteractionRepository, type InteractionService } from '@control-plane/domain'
import { type PolicyDecisionPoint, type PolicySnapshotReference } from '@control-plane/policy'
import {
  DurableToolCallRequestSchema,
  ToolAuthorizationRequestSchema,
  ToolCallSchema,
  ToolPolicyDecisionSchema,
  type DurableToolCallRequest,
  type ToolApprovalCoordinator,
  type ToolAuthorizationRequest,
  type ToolCall,
  type ToolCallStatus,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolPolicyAuthorizer,
  type ToolPolicyDecision,
} from '@control-plane/tool-sdk'
import { ToolGateway, ToolGatewayError, type PreparedToolExecution } from './tool-registry.js'

export interface ToolCallRepository {
  insert(call: ToolCall): Promise<boolean>
  get(toolCallId: string): Promise<ToolCall | undefined>
  getByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<ToolCall | undefined>
  compareAndSet(expectedRevision: number, call: ToolCall): Promise<boolean>
  listByExecution(executionId: string): Promise<readonly ToolCall[]>
}

export class InMemoryToolCallRepository implements ToolCallRepository {
  readonly #calls = new Map<string, ToolCall>()
  readonly #idempotency = new Map<string, string>()

  async insert(call: ToolCall): Promise<boolean> {
    const key = idempotencyIndex(call.workspaceId, call.idempotencyKey)
    if (this.#calls.has(call.toolCallId) || this.#idempotency.has(key)) return false
    this.#calls.set(call.toolCallId, clone(call))
    this.#idempotency.set(key, call.toolCallId)
    return true
  }

  async get(toolCallId: string): Promise<ToolCall | undefined> {
    return cloneOptional(this.#calls.get(toolCallId))
  }

  async getByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<ToolCall | undefined> {
    const toolCallId = this.#idempotency.get(idempotencyIndex(workspaceId, idempotencyKey))
    return toolCallId === undefined ? undefined : this.get(toolCallId)
  }

  async compareAndSet(expectedRevision: number, call: ToolCall): Promise<boolean> {
    if (this.#calls.get(call.toolCallId)?.revision !== expectedRevision) return false
    this.#calls.set(call.toolCallId, clone(ToolCallSchema.parse(call)))
    return true
  }

  async listByExecution(executionId: string): Promise<readonly ToolCall[]> {
    return [...this.#calls.values()]
      .filter((call) => call.executionId === executionId)
      .toSorted((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map(clone)
  }
}

export interface ToolRateLimiter {
  consume(key: string, limit: number, windowMs: number, at: string): Promise<boolean>
}

export class InMemoryToolRateLimiter implements ToolRateLimiter {
  readonly #windows = new Map<string, number[]>()

  async consume(key: string, limit: number, windowMs: number, at: string): Promise<boolean> {
    const now = Date.parse(at)
    const active = (this.#windows.get(key) ?? []).filter((entry) => entry > now - windowMs)
    if (active.length >= limit) return false
    active.push(now)
    this.#windows.set(key, active)
    return true
  }
}

export class StaticToolPolicyAuthorizer implements ToolPolicyAuthorizer {
  readonly requests: ToolAuthorizationRequest[] = []

  constructor(readonly decision: ToolPolicyDecision) {}

  async authorize(input: ToolAuthorizationRequest): Promise<ToolPolicyDecision> {
    this.requests.push(clone(ToolAuthorizationRequestSchema.parse(input)))
    return clone(ToolPolicyDecisionSchema.parse(this.decision))
  }
}

export class PolicyDecisionPointToolAuthorizer implements ToolPolicyAuthorizer {
  constructor(
    readonly decisionPoint: PolicyDecisionPoint,
    readonly resolveSnapshot: (
      reference: string
    ) => PolicySnapshotReference | undefined | Promise<PolicySnapshotReference | undefined>
  ) {}

  async authorize(input: ToolAuthorizationRequest): Promise<ToolPolicyDecision> {
    const request = ToolAuthorizationRequestSchema.parse(input)
    const snapshot = await this.resolveSnapshot(request.policySnapshotRef)
    if (!snapshot) {
      return ToolPolicyDecisionSchema.parse({
        effect: 'deny',
        decisionId: `policy-missing-${request.toolCallId}`,
        policyVersion: request.policySnapshotRef,
        reasonCode: 'POLICY_MISSING',
        requiresApproval: false,
        evaluatedAt: request.requestedAt,
      })
    }
    const decision = await this.decisionPoint.authorize({
      requestId: request.requestId,
      principal: {
        type: 'service',
        id: request.principalRef,
        workspaceId: request.workspaceId,
      },
      action: 'tool:invoke',
      resource: {
        type: 'tool',
        id: request.toolVersionId,
        workspaceId: request.workspaceId,
        attributes: {
          toolDefinitionId: request.toolDefinitionId,
          operation: request.operation,
          riskClass: request.riskClass,
          requiredCapabilities: request.requiredCapabilities,
          inputDigest: request.inputDigest,
        },
      },
      context: {
        workspaceId: request.workspaceId,
        requestedAt: request.requestedAt,
        attributes: {
          executionId: request.executionId,
          attemptId: request.attemptId,
          profileId: request.profileId,
          toolCallId: request.toolCallId,
        },
      },
      policySnapshot: snapshot,
    })
    return ToolPolicyDecisionSchema.parse({
      effect: decision.effect,
      decisionId: decision.decisionId,
      policyVersion: `${decision.policySnapshot.policyId}@${decision.policySnapshot.version}:${decision.policySnapshot.digest}`,
      reasonCode: decision.reasonCode,
      requiresApproval: false,
      evaluatedAt: decision.evaluatedAt,
    })
  }
}

export class InteractionToolApprovalCoordinator implements ToolApprovalCoordinator {
  constructor(
    readonly interactions: InteractionService,
    readonly repository: InteractionRepository
  ) {}

  async review(input: Parameters<ToolApprovalCoordinator['review']>[0]) {
    let interaction = await this.repository.get(input.interactionId)
    if (!interaction) {
      interaction = await this.interactions.request({
        interactionId: input.interactionId,
        executionId: input.executionId,
        attemptId: input.attemptId,
        kind: 'approval',
        prompt: {
          title: input.title,
          detailsReference: `artifact://tool-call/${input.toolCallId}`,
        },
        allowedActions: ['approve', 'deny'],
        allowedPrincipalIds: input.allowedPrincipalIds,
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt,
      })
    }
    if (interaction.state === 'pending') {
      return { state: 'pending' as const, interactionId: interaction.interactionId }
    }
    if (interaction.state === 'expired') {
      return { state: 'expired' as const, interactionId: interaction.interactionId }
    }
    if (interaction.state === 'cancelled') {
      return { state: 'revoked' as const, interactionId: interaction.interactionId }
    }
    const approved = interaction.response?.action === 'approve'
    return {
      state: approved ? ('approved' as const) : ('denied' as const),
      interactionId: interaction.interactionId,
      ...(interaction.response
        ? { decisionPrincipalRef: interaction.response.respondingPrincipalId }
        : {}),
    }
  }
}

export type ToolExecutionServiceErrorCode =
  | 'TOOL_CALL_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'POLICY_EVALUATION_FAILED'
  | 'RATE_LIMITED'
  | 'TOOL_EXECUTION_FAILED'
  | 'STALE_TOOL_CALL'

export class ToolExecutionServiceError extends Error {
  constructor(readonly code: ToolExecutionServiceErrorCode) {
    super(code)
    this.name = 'ToolExecutionServiceError'
  }
}

export type DurableToolExecutionOutcome =
  | { readonly state: 'awaiting_approval'; readonly call: ToolCall }
  | { readonly state: 'denied'; readonly call: ToolCall }
  | { readonly state: 'failed'; readonly call: ToolCall }
  | { readonly state: 'reconciliation_required'; readonly call: ToolCall }
  | { readonly state: 'in_progress'; readonly call: ToolCall }
  | {
      readonly state: 'succeeded'
      readonly call: ToolCall
      readonly result: ToolExecutionResult
    }

export class PolicyControlledToolExecutionService {
  readonly gateway: ToolGateway
  readonly calls: ToolCallRepository
  readonly authorizer: ToolPolicyAuthorizer
  readonly approvals: ToolApprovalCoordinator
  readonly rateLimiter: ToolRateLimiter
  readonly now: () => string
  readonly #inFlight = new Map<
    string,
    { readonly requestDigest: string; readonly promise: Promise<DurableToolExecutionOutcome> }
  >()

  constructor(options: {
    readonly gateway: ToolGateway
    readonly calls: ToolCallRepository
    readonly authorizer: ToolPolicyAuthorizer
    readonly approvals: ToolApprovalCoordinator
    readonly rateLimiter: ToolRateLimiter
    readonly now?: () => string
  }) {
    this.gateway = options.gateway
    this.calls = options.calls
    this.authorizer = options.authorizer
    this.approvals = options.approvals
    this.rateLimiter = options.rateLimiter
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async execute(input: unknown): Promise<DurableToolExecutionOutcome> {
    const request = DurableToolCallRequestSchema.parse(input)
    const prepared = await this.gateway.prepare(toGatewayRequest(request))
    const requestDigest = toolRequestDigest(request)
    const key = idempotencyIndex(request.workspaceId, request.idempotencyKey)
    const active = this.#inFlight.get(key)
    if (active) {
      if (active.requestDigest !== requestDigest) fail('IDEMPOTENCY_CONFLICT')
      return active.promise
    }
    const promise = this.#executePrepared(request, prepared, requestDigest)
    this.#inFlight.set(key, { requestDigest, promise })
    try {
      return await promise
    } finally {
      if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key)
    }
  }

  async #executePrepared(
    request: DurableToolCallRequest,
    prepared: PreparedToolExecution,
    requestDigest: string
  ): Promise<DurableToolExecutionOutcome> {
    let call = await this.calls.getByIdempotencyKey(request.workspaceId, request.idempotencyKey)
    if (call) {
      if (call.requestDigest !== requestDigest) fail('IDEMPOTENCY_CONFLICT')
      const terminal = terminalOutcome(call)
      if (terminal) return terminal
      if (call.status === 'executing') return { state: 'in_progress', call }
    } else {
      call = ToolCallSchema.parse({
        toolCallId: request.toolCallId,
        requestDigest,
        executionId: request.executionId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        profileId: request.profileId,
        principalRef: request.audit.principalRef,
        toolDefinitionId: request.toolDefinitionId,
        toolVersionId: request.toolVersionId,
        operation: request.operation,
        inputDigest: digest(request.input),
        policySnapshotRef: request.policySnapshotRef,
        executor: prepared.version.executor,
        idempotencyKey: request.idempotencyKey,
        status: 'requested',
        revision: 1,
        requestedAt: request.requestedAt,
        history: [{ status: 'requested', at: request.requestedAt }],
      })
      if (!(await this.calls.insert(call))) fail('TOOL_CALL_CONFLICT')
    }

    if (!call.policyDecision) {
      let decision: ToolPolicyDecision
      try {
        decision = await this.authorizer.authorize(authorizationRequest(request, prepared, call))
      } catch {
        await this.#transition(call, 'failed', this.now(), {
          errorCode: 'POLICY_EVALUATION_FAILED',
        })
        fail('POLICY_EVALUATION_FAILED')
      }
      call = await this.#update(call, { policyDecision: decision })
      if (decision.effect === 'deny') {
        call = await this.#transition(call, 'denied', decision.evaluatedAt, {}, decision.reasonCode)
        return { state: 'denied', call }
      }
    }

    const requiresApproval =
      prepared.operation.approvalMode === 'always' || call.policyDecision?.requiresApproval === true
    if (requiresApproval && call.status !== 'authorized') {
      if (!request.approval) {
        call = await this.#transition(
          call,
          'denied',
          this.now(),
          { errorCode: 'APPROVAL_REQUIRED' },
          'APPROVAL_REQUIRED'
        )
        return { state: 'denied', call }
      }
      const review = await this.approvals.review({
        toolCallId: call.toolCallId,
        interactionId: request.approval.interactionId,
        executionId: call.executionId,
        attemptId: call.attemptId,
        title: `Approve ${prepared.operation.name}`,
        allowedPrincipalIds: request.approval.allowedPrincipalIds,
        requestedAt: request.approval.requestedAt,
        expiresAt: request.approval.expiresAt,
      })
      if (review.interactionId !== request.approval.interactionId) fail('TOOL_CALL_CONFLICT')
      if (review.state !== 'approved') {
        if (review.state === 'pending') {
          call = await this.#transition(call, 'awaiting_approval', request.approval.requestedAt, {
            approvalInteractionId: request.approval.interactionId,
          })
          return { state: 'awaiting_approval', call }
        }
        call = await this.#transition(
          call,
          'denied',
          this.now(),
          {
            approvalInteractionId: request.approval.interactionId,
            errorCode: approvalError(review.state),
          },
          approvalError(review.state)
        )
        return { state: 'denied', call }
      }
      call = await this.#transition(call, 'authorized', this.now(), {
        approvalInteractionId: request.approval.interactionId,
        ...(review.decisionPrincipalRef
          ? { approvalPrincipalRef: review.decisionPrincipalRef }
          : {}),
        authorizedAt: this.now(),
      })
    } else if (call.status === 'requested') {
      call = await this.#transition(call, 'authorized', this.now(), { authorizedAt: this.now() })
    }

    const limit = prepared.version.limits.rateLimit ?? { maxCalls: 60, windowMs: 60_000 }
    const rateKey = [
      call.workspaceId,
      call.principalRef,
      call.toolDefinitionId,
      call.operation,
    ].join(':')
    if (
      !(await this.rateLimiter.consume(
        rateKey,
        limit.maxCalls,
        limit.windowMs,
        request.requestedAt
      ))
    ) {
      await this.#transition(
        call,
        'failed',
        this.now(),
        { errorCode: 'RATE_LIMITED' },
        'RATE_LIMITED'
      )
      fail('RATE_LIMITED')
    }

    call = await this.#transition(call, 'executing', this.now(), { startedAt: this.now() })
    try {
      const result = await this.gateway.invoke(prepared)
      call = await this.#transition(call, 'succeeded', this.now(), {
        result,
        completedAt: this.now(),
      })
      return { state: 'succeeded', call, result }
    } catch (error) {
      const ambiguous = error instanceof ToolGatewayError && error.effectState !== 'none'
      call = await this.#transition(
        call,
        ambiguous ? 'reconciliation_required' : 'failed',
        this.now(),
        { errorCode: normalizedExecutionCode(error), completedAt: this.now() },
        normalizedExecutionCode(error)
      )
      if (ambiguous) return { state: 'reconciliation_required', call }
      fail('TOOL_EXECUTION_FAILED')
    }
  }

  async #update(call: ToolCall, fields: Partial<ToolCall>): Promise<ToolCall> {
    const next = ToolCallSchema.parse({ ...call, ...fields, revision: call.revision + 1 })
    if (!(await this.calls.compareAndSet(call.revision, next))) fail('STALE_TOOL_CALL')
    return next
  }

  async #transition(
    call: ToolCall,
    status: ToolCallStatus,
    at: string,
    fields: Partial<ToolCall> = {},
    reasonCode?: string
  ): Promise<ToolCall> {
    return this.#update(call, {
      ...fields,
      status,
      history: [...call.history, { status, at, ...(reasonCode ? { reasonCode } : {}) }],
    })
  }
}

function authorizationRequest(
  request: DurableToolCallRequest,
  prepared: PreparedToolExecution,
  call: ToolCall
): ToolAuthorizationRequest {
  return ToolAuthorizationRequestSchema.parse({
    requestId: request.requestId,
    toolCallId: call.toolCallId,
    executionId: call.executionId,
    attemptId: call.attemptId,
    workspaceId: call.workspaceId,
    profileId: call.profileId,
    principalRef: call.principalRef,
    toolDefinitionId: call.toolDefinitionId,
    toolVersionId: call.toolVersionId,
    operation: call.operation,
    inputDigest: call.inputDigest,
    riskClass: prepared.operation.riskClass,
    requiredCapabilities: prepared.operation.requiredCapabilities,
    policySnapshotRef: call.policySnapshotRef,
    requestedAt: request.requestedAt,
  })
}

function toolRequestDigest(request: DurableToolCallRequest): string {
  return digest({
    toolCallId: request.toolCallId,
    executionId: request.executionId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    profileId: request.profileId,
    principalRef: request.audit.principalRef,
    toolDefinitionId: request.toolDefinitionId,
    toolVersionId: request.toolVersionId,
    operation: request.operation,
    input: request.input,
    idempotencyKey: request.idempotencyKey,
    policySnapshotRef: request.policySnapshotRef,
  })
}

function toGatewayRequest(request: DurableToolCallRequest): ToolExecutionRequest {
  return {
    requestId: request.requestId,
    executionId: request.executionId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    profileId: request.profileId,
    toolDefinitionId: request.toolDefinitionId,
    toolVersionId: request.toolVersionId,
    operation: request.operation,
    input: request.input,
    grant: request.grant,
    audit: request.audit,
  }
}

function terminalOutcome(call: ToolCall): DurableToolExecutionOutcome | undefined {
  if (call.status === 'succeeded' && call.result) {
    return { state: 'succeeded', call, result: call.result }
  }
  if (call.status === 'denied') return { state: 'denied', call }
  if (call.status === 'failed') return { state: 'failed', call }
  if (call.status === 'reconciliation_required') return { state: 'reconciliation_required', call }
  return undefined
}

function approvalError(state: 'denied' | 'expired' | 'revoked'): string {
  if (state === 'expired') return 'APPROVAL_EXPIRED'
  if (state === 'revoked') return 'APPROVAL_REVOKED'
  return 'APPROVAL_DENIED'
}

function normalizedExecutionCode(error: unknown): string {
  if (error instanceof ToolGatewayError) return error.executorCode ?? error.code
  return 'EXECUTOR_ERROR'
}

function idempotencyIndex(workspaceId: string, idempotencyKey: string): string {
  return `${workspaceId}:${idempotencyKey}`
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}

function fail(code: ToolExecutionServiceErrorCode): never {
  throw new ToolExecutionServiceError(code)
}

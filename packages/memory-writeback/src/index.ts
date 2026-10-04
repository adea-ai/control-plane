import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  MemoryWritePolicySchema,
  MemoryWriteProposalSchema,
  type MemoryWritePolicy,
  type MemoryWriteProposal,
} from '@control-plane/contracts'
import {
  InteractionRequestSchema,
  type InMemoryInteractionRepository,
  type InteractionRequest,
  type InteractionRepository,
} from '@control-plane/domain'
import { z } from 'zod'

const ProposalInputSchema = z.object(MemoryWriteProposalSchema.shape).omit({
  state: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  approvalInteractionId: true,
  outcome: true,
})
const ApprovalInputSchema = z.object({
  interactionId: z.string().regex(/^int_[0-9A-HJKMNP-TV-Z]{26}$/),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})

export interface MemoryWriteProposalRepository {
  insert(proposal: MemoryWriteProposal): Promise<boolean>
  /** Atomically inserts both records or neither; duplicate proposals create no interaction. */
  insertWithApproval?(
    proposal: MemoryWriteProposal,
    interaction: InteractionRequest
  ): Promise<boolean>
  get(proposalId: string): Promise<MemoryWriteProposal | undefined>
  getByDedupe(workspaceId: string, dedupeHint: string): Promise<MemoryWriteProposal | undefined>
  compareAndSet(expectedVersion: number, proposal: MemoryWriteProposal): Promise<boolean>
  list(): Promise<MemoryWriteProposal[]>
}

/** Retention and deduplication rely on this identity remaining stable across transitions. */
export function assertMemoryWriteProposalIdentity(
  current: MemoryWriteProposal,
  next: MemoryWriteProposal
): void {
  if (
    current.workspaceId !== next.workspaceId ||
    current.dedupeHint !== next.dedupeHint ||
    current.provenance.sourceExecutionId !== next.provenance.sourceExecutionId ||
    current.provenance.sourceAttemptId !== next.provenance.sourceAttemptId
  )
    throw new Error('MEMORY_PROPOSAL_IDENTITY_MISMATCH')
}

export class InMemoryMemoryWriteProposalRepository implements MemoryWriteProposalRepository {
  readonly #proposals = new Map<string, MemoryWriteProposal>()
  #insertTail: Promise<void> = Promise.resolve()
  constructor(readonly interactions?: InMemoryInteractionRepository) {}

  insert(proposal: MemoryWriteProposal): Promise<boolean> {
    return this.#insert(proposal)
  }
  insertWithApproval(proposal: MemoryWriteProposal, interaction: InteractionRequest) {
    return this.#insert(proposal, parseMemoryWriteApproval(proposal, interaction))
  }
  #insert(proposal: MemoryWriteProposal, interaction?: InteractionRequest): Promise<boolean> {
    const parsed = structuredClone(MemoryWriteProposalSchema.parse(proposal))
    const operation = this.#insertTail.then(async () => {
      if (
        this.#proposals.has(parsed.proposalId) ||
        [...this.#proposals.values()].some(
          (entry) =>
            entry.workspaceId === parsed.workspaceId && entry.dedupeHint === parsed.dedupeHint
        )
      )
        return false
      if (interaction) {
        if (!this.interactions) fail('MEMORY_APPROVAL_ATOMICITY_UNAVAILABLE')
        if (!this.interactions.insertSynchronously(interaction)) fail('MEMORY_PROPOSAL_CONFLICT')
      }
      this.#proposals.set(parsed.proposalId, parsed)
      return true
    })
    this.#insertTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
  async get(proposalId: string): Promise<MemoryWriteProposal | undefined> {
    const proposal = this.#proposals.get(proposalId)
    return proposal ? structuredClone(proposal) : undefined
  }
  async getByDedupe(workspaceId: string, dedupeHint: string) {
    const proposal = [...this.#proposals.values()].find(
      (entry) => entry.workspaceId === workspaceId && entry.dedupeHint === dedupeHint
    )
    return proposal ? structuredClone(proposal) : undefined
  }
  async compareAndSet(expectedVersion: number, proposal: MemoryWriteProposal): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    const current = this.#proposals.get(parsed.proposalId)
    if (!current || current.version !== expectedVersion) return false
    assertMemoryWriteProposalIdentity(current, parsed)
    this.#proposals.set(parsed.proposalId, structuredClone(parsed))
    return true
  }
  async list(): Promise<MemoryWriteProposal[]> {
    return [...this.#proposals.values()].map((proposal) => structuredClone(proposal))
  }
}

export interface MemoryProviderWriteRequest {
  providerId: string
  connectionId: string
  workspaceId: string
  scopeDigest: string
  idempotencyKey: string
  memoryType: MemoryWriteProposal['memoryType']
  content: string
  contentDigest: string
  retention: MemoryWriteProposal['retention']
  provenance: MemoryWriteProposal['provenance']
}

export interface MemoryProviderWriter {
  readonly providerId: string
  readonly connectionId: string
  readonly workspaceId: string
  readonly scopeDigest: string
  readonly capabilities: { writeCommit: boolean; idempotentStatus: boolean }
  write(
    request: MemoryProviderWriteRequest
  ): Promise<
    | { status: 'committed'; providerMemoryRef: string }
    | { status: 'rejected' }
    | { status: 'unknown' }
  >
  status(
    idempotencyKey: string
  ): Promise<
    | { status: 'committed'; providerMemoryRef: string }
    | { status: 'rejected' }
    | { status: 'unknown' }
  >
}

export type MemoryWriteErrorCode =
  | 'MEMORY_WRITE_DISABLED'
  | 'MEMORY_PROVIDER_ABSENT'
  | 'MEMORY_PROVIDER_READ_ONLY'
  | 'MEMORY_SCOPE_MISMATCH'
  | 'MEMORY_CONTENT_DIGEST_MISMATCH'
  | 'MEMORY_CONTENT_NOT_ALLOWED'
  | 'MEMORY_PROPOSAL_CONFLICT'
  | 'MEMORY_PROPOSAL_MISSING'
  | 'MEMORY_APPROVAL_REQUIRED'
  | 'MEMORY_APPROVAL_ATOMICITY_UNAVAILABLE'
  | 'MEMORY_APPROVAL_PENDING'
  | 'MEMORY_APPROVAL_STALE'
  | 'MEMORY_PROPOSAL_TERMINAL'
  | 'MEMORY_WRITE_AMBIGUOUS'
  | 'MEMORY_WRITE_REJECTED'

export class MemoryWriteError extends Error {
  constructor(readonly code: MemoryWriteErrorCode) {
    super(code)
    this.name = 'MemoryWriteError'
  }
}

/**
 * Observability port for approval decisions. Implementations must supply bounded
 * label cardinality and isolate exporter failures; the service additionally
 * isolates every hook call so a throwing metrics sink can never change a decision.
 */
export interface MemoryWriteDecisionMetrics {
  recordApprovalDecision(decision: 'approved' | 'denied' | 'expired'): void
}

export interface MemoryWriteServiceOptions {
  repository: MemoryWriteProposalRepository
  provider?: MemoryProviderWriter
  interactionRepository: InteractionRepository
  now?: () => string
  metrics?: MemoryWriteDecisionMetrics
}

export class MemoryWriteService {
  readonly #repository: MemoryWriteProposalRepository
  readonly #provider: MemoryProviderWriter | undefined
  readonly #interactionRepository: InteractionRepository
  readonly #now: () => string
  readonly #metrics: MemoryWriteDecisionMetrics | undefined

  constructor(options: MemoryWriteServiceOptions) {
    this.#repository = options.repository
    this.#provider = options.provider
    this.#interactionRepository = options.interactionRepository
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#metrics = options.metrics
  }

  /** Emission is isolated per decision and can never change an approval outcome. */
  #emitApprovalDecision(decision: 'approved' | 'denied' | 'expired'): void {
    if (this.#metrics === undefined) return
    try {
      this.#metrics.recordApprovalDecision(decision)
    } catch {
      // Observability is deliberately non-authoritative and fail-open.
    }
  }

  async propose(
    input: unknown,
    policyInput: unknown,
    approvalInput?: unknown
  ): Promise<MemoryWriteProposal> {
    const policy = MemoryWritePolicySchema.parse(policyInput)
    if (policy.mode === 'disabled') fail('MEMORY_WRITE_DISABLED')
    const provider = this.#assertProvider()
    const parsed = ProposalInputSchema.parse(input)
    this.#assertScope(parsed, provider)
    this.#assertContent(parsed, policy)
    const existing = await this.#repository.getByDedupe(parsed.workspaceId, parsed.dedupeHint)
    if (existing) {
      if (sameProposalInput(existing, parsed)) return existing
      fail('MEMORY_PROPOSAL_CONFLICT')
    }
    const createdAt = z.iso.datetime().parse(this.#now())
    let proposal = MemoryWriteProposalSchema.parse({
      ...parsed,
      state: policy.mode === 'approval_required' ? 'awaiting_approval' : 'proposed',
      version: 1,
      createdAt,
      updatedAt: createdAt,
    })
    let interaction: InteractionRequest | undefined
    if (policy.mode === 'approval_required') {
      if (!this.#repository.insertWithApproval) fail('MEMORY_APPROVAL_ATOMICITY_UNAVAILABLE')
      const approval = ApprovalInputSchema.parse(approvalInput)
      if (policy.approvalPrincipalIds.length === 0) fail('MEMORY_APPROVAL_REQUIRED')
      interaction = InteractionRequestSchema.parse({
        state: 'pending',
        version: 1,
        interactionId: approval.interactionId,
        executionId: parsed.provenance.sourceExecutionId,
        attemptId: parsed.provenance.sourceAttemptId,
        kind: 'approval',
        prompt: {
          title: 'Approve durable memory write',
          detailsReference: `memory-write://proposal/${parsed.proposalId}`,
        },
        allowedActions: ['approve', 'deny'],
        allowedPrincipalIds: policy.approvalPrincipalIds,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
      })
      proposal = MemoryWriteProposalSchema.parse({
        ...proposal,
        approvalInteractionId: approval.interactionId,
      })
    }
    const inserted = interaction
      ? await this.#repository.insertWithApproval!(proposal, interaction)
      : await this.#repository.insert(proposal)
    if (!inserted) {
      const winner = await this.#repository.getByDedupe(parsed.workspaceId, parsed.dedupeHint)
      if (winner && sameProposalInput(winner, parsed)) return winner
      fail('MEMORY_PROPOSAL_CONFLICT')
    }
    return proposal
  }

  async applyApproval(proposalId: string, observedAt: string): Promise<MemoryWriteProposal> {
    const proposal = await this.#get(proposalId)
    if (
      (proposal.state === 'approved' && proposal.outcome?.code === 'approved') ||
      (proposal.state === 'denied' && proposal.outcome?.code === 'denied') ||
      (proposal.state === 'expired' && proposal.outcome?.code === 'expired')
    )
      return proposal
    if (proposal.state !== 'awaiting_approval') fail('MEMORY_PROPOSAL_TERMINAL')
    if (!proposal.approvalInteractionId) fail('MEMORY_APPROVAL_REQUIRED')
    const interaction = await this.#interactionRepository.get(proposal.approvalInteractionId)
    if (!interaction || interaction.state === 'pending') fail('MEMORY_APPROVAL_PENDING')
    if (
      interaction.state === 'expired' ||
      Date.parse(observedAt) >= Date.parse(interaction.expiresAt)
    ) {
      this.#emitApprovalDecision('expired')
      return this.#transition(proposal, 'expired', observedAt, 'expired')
    }
    if (interaction.state !== 'responded' || !interaction.response) fail('MEMORY_APPROVAL_STALE')
    if (interaction.response.action === 'deny') {
      this.#emitApprovalDecision('denied')
      return this.#transition(proposal, 'denied', observedAt, 'denied')
    }
    if (interaction.response.action !== 'approve') fail('MEMORY_APPROVAL_STALE')
    this.#emitApprovalDecision('approved')
    return this.#transition(proposal, 'approved', observedAt, 'approved')
  }

  async revoke(proposalId: string, observedAt: string): Promise<MemoryWriteProposal> {
    const proposal = await this.#get(proposalId)
    if (!['proposed', 'awaiting_approval', 'approved'].includes(proposal.state))
      fail('MEMORY_PROPOSAL_TERMINAL')
    return this.#transition(proposal, 'revoked', observedAt, 'revoked')
  }

  async commit(proposalId: string, observedAt: string): Promise<MemoryWriteProposal> {
    let proposal = await this.#get(proposalId)
    if (proposal.state === 'committed') return proposal
    if (!['approved', 'committing', 'reconciliation_required'].includes(proposal.state))
      fail(
        ['proposed', 'awaiting_approval'].includes(proposal.state)
          ? 'MEMORY_APPROVAL_REQUIRED'
          : 'MEMORY_PROPOSAL_TERMINAL'
      )
    if (
      proposal.state === 'approved' &&
      proposal.provenance.expiresAt &&
      Date.parse(observedAt) >= Date.parse(proposal.provenance.expiresAt)
    )
      return this.#transition(proposal, 'expired', observedAt, 'expired')
    const provider = this.#assertProvider(proposal.state === 'approved')
    this.#assertScope(proposal, provider)
    const request = toWriteRequest(proposal)
    if (proposal.state === 'committing' || proposal.state === 'reconciliation_required') {
      if (!provider.capabilities.idempotentStatus) {
        if (proposal.state === 'committing')
          await this.#transition(proposal, 'reconciliation_required', observedAt, 'ambiguous')
        fail('MEMORY_WRITE_AMBIGUOUS')
      }
      let status: Awaited<ReturnType<MemoryProviderWriter['status']>>
      try {
        status = await provider.status(request.idempotencyKey)
      } catch {
        if (proposal.state === 'committing')
          await this.#transition(proposal, 'reconciliation_required', observedAt, 'ambiguous')
        fail('MEMORY_WRITE_AMBIGUOUS')
      }
      if (status.status === 'committed')
        return this.#transition(
          proposal,
          'committed',
          observedAt,
          'reconciled',
          status.providerMemoryRef
        )
      if (status.status === 'rejected') {
        await this.#transition(proposal, 'failed', observedAt, 'failed')
        fail('MEMORY_WRITE_REJECTED')
      }
      if (proposal.state === 'committing')
        await this.#transition(proposal, 'reconciliation_required', observedAt, 'ambiguous')
      fail('MEMORY_WRITE_AMBIGUOUS')
    }
    proposal = await this.#transition(proposal, 'committing', observedAt)
    let result: Awaited<ReturnType<MemoryProviderWriter['write']>>
    let reconciled = false
    try {
      result = await provider.write(request)
    } catch {
      result = { status: 'unknown' }
    }
    if (result.status === 'unknown' && provider.capabilities.idempotentStatus) {
      try {
        result = await provider.status(request.idempotencyKey)
        reconciled = result.status === 'committed'
      } catch {
        result = { status: 'unknown' }
      }
    }
    if (result.status === 'committed')
      return this.#transition(
        proposal,
        'committed',
        observedAt,
        reconciled ? 'reconciled' : 'committed',
        result.providerMemoryRef
      )
    if (result.status === 'rejected') {
      await this.#transition(proposal, 'failed', observedAt, 'failed')
      fail('MEMORY_WRITE_REJECTED')
    }
    await this.#transition(proposal, 'reconciliation_required', observedAt, 'ambiguous')
    fail('MEMORY_WRITE_AMBIGUOUS')
  }

  async #transition(
    proposal: MemoryWriteProposal,
    state: MemoryWriteProposal['state'],
    observedAt: string,
    code?: NonNullable<MemoryWriteProposal['outcome']>['code'],
    providerMemoryRef?: string
  ): Promise<MemoryWriteProposal> {
    const next = MemoryWriteProposalSchema.parse({
      ...proposal,
      state,
      version: proposal.version + 1,
      updatedAt: observedAt,
      ...(code
        ? {
            outcome: {
              code,
              observedAt,
              ...(providerMemoryRef === undefined ? {} : { providerMemoryRef }),
            },
          }
        : {}),
    })
    if (!(await this.#repository.compareAndSet(proposal.version, next)))
      fail('MEMORY_PROPOSAL_CONFLICT')
    return next
  }

  async #get(proposalId: string): Promise<MemoryWriteProposal> {
    const proposal = await this.#repository.get(proposalId)
    if (!proposal) fail('MEMORY_PROPOSAL_MISSING')
    return proposal
  }

  #assertProvider(requireWriteCommit = true): MemoryProviderWriter {
    if (!this.#provider) fail('MEMORY_PROVIDER_ABSENT')
    if (requireWriteCommit && !this.#provider.capabilities.writeCommit)
      fail('MEMORY_PROVIDER_READ_ONLY')
    return this.#provider
  }

  #assertScope(
    proposal: Pick<
      MemoryWriteProposal,
      'providerId' | 'connectionId' | 'workspaceId' | 'scopeDigest'
    >,
    provider: MemoryProviderWriter
  ): void {
    if (
      proposal.providerId !== provider.providerId ||
      proposal.connectionId !== provider.connectionId ||
      proposal.workspaceId !== provider.workspaceId ||
      proposal.scopeDigest !== provider.scopeDigest
    )
      fail('MEMORY_SCOPE_MISMATCH')
  }

  #assertContent(proposal: z.output<typeof ProposalInputSchema>, policy: MemoryWritePolicy): void {
    if (digest(proposal.content) !== proposal.contentDigest) fail('MEMORY_CONTENT_DIGEST_MISMATCH')
    if (
      Buffer.byteLength(proposal.content, 'utf8') > policy.maximumBytes ||
      !policy.allowedSensitivities.includes(proposal.provenance.sensitivity) ||
      /(?:full transcript|unrestricted log|source document)/i.test(proposal.content)
    )
      fail('MEMORY_CONTENT_NOT_ALLOWED')
  }
}

export class FakeMemoryProviderWriter implements MemoryProviderWriter {
  readonly records = new Map<string, string>()
  constructor(
    readonly providerId: string,
    readonly connectionId: string,
    readonly workspaceId: string,
    readonly scopeDigest: string,
    readonly capabilities = { writeCommit: true, idempotentStatus: true },
    private readonly behavior:
      | 'success'
      | 'reject'
      | 'timeout_before'
      | 'timeout_after'
      | 'ambiguous' = 'success'
  ) {}
  async write(request: MemoryProviderWriteRequest) {
    if (this.behavior === 'reject') return { status: 'rejected' as const }
    if (this.behavior === 'timeout_before') throw new Error('timeout')
    if (!this.records.has(request.idempotencyKey))
      this.records.set(request.idempotencyKey, `memory://${this.records.size + 1}`)
    if (this.behavior === 'timeout_after') throw new Error('timeout')
    if (this.behavior === 'ambiguous') return { status: 'unknown' as const }
    const providerMemoryRef = this.records.get(request.idempotencyKey)
    if (!providerMemoryRef) throw new Error('fake provider record missing')
    return {
      status: 'committed' as const,
      providerMemoryRef,
    }
  }
  async status(idempotencyKey: string) {
    const providerMemoryRef = this.records.get(idempotencyKey)
    return providerMemoryRef
      ? { status: 'committed' as const, providerMemoryRef }
      : { status: 'unknown' as const }
  }
}

/** Validate the immutable link before a persistence adapter changes either record. */
export function parseMemoryWriteApproval(
  proposalInput: MemoryWriteProposal,
  interactionInput: InteractionRequest
): InteractionRequest {
  const proposal = MemoryWriteProposalSchema.parse(proposalInput)
  const interaction = InteractionRequestSchema.parse(interactionInput)
  if (
    proposal.state !== 'awaiting_approval' ||
    proposal.version !== 1 ||
    proposal.approvalInteractionId !== interaction.interactionId ||
    proposal.provenance.sourceExecutionId !== interaction.executionId ||
    proposal.provenance.sourceAttemptId !== interaction.attemptId ||
    interaction.kind !== 'approval' ||
    interaction.state !== 'pending' ||
    interaction.version !== 1 ||
    interaction.prompt.detailsReference !== `memory-write://proposal/${proposal.proposalId}` ||
    !isDeepStrictEqual(interaction.allowedActions, ['approve', 'deny'])
  )
    fail('MEMORY_PROPOSAL_CONFLICT')
  return interaction
}

function toWriteRequest(proposal: MemoryWriteProposal): MemoryProviderWriteRequest {
  return {
    providerId: proposal.providerId,
    connectionId: proposal.connectionId,
    workspaceId: proposal.workspaceId,
    scopeDigest: proposal.scopeDigest,
    idempotencyKey: `memory:${proposal.proposalId}:${proposal.contentDigest}`,
    memoryType: proposal.memoryType,
    content: proposal.content,
    contentDigest: proposal.contentDigest,
    retention: proposal.retention,
    provenance: proposal.provenance,
  }
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function sameProposalInput(
  existing: MemoryWriteProposal,
  input: z.output<typeof ProposalInputSchema>
): boolean {
  const existingInput = ProposalInputSchema.parse(existing)
  return isDeepStrictEqual(existingInput, { ...input, proposalId: existingInput.proposalId })
}

function fail(code: MemoryWriteErrorCode): never {
  throw new MemoryWriteError(code)
}

export const packageName = 'memory-writeback'

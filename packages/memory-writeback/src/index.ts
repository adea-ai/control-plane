import { createHash } from 'node:crypto'
import {
  MemoryWritePolicySchema,
  MemoryWriteProposalSchema,
  type MemoryWritePolicy,
  type MemoryWriteProposal,
} from '@control-plane/contracts'
import { InteractionService, type InteractionRepository } from '@control-plane/domain'
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
  get(proposalId: string): Promise<MemoryWriteProposal | undefined>
  getByDedupe(workspaceId: string, dedupeHint: string): Promise<MemoryWriteProposal | undefined>
  compareAndSet(expectedVersion: number, proposal: MemoryWriteProposal): Promise<boolean>
  list(): Promise<MemoryWriteProposal[]>
}

export class InMemoryMemoryWriteProposalRepository implements MemoryWriteProposalRepository {
  readonly #proposals = new Map<string, MemoryWriteProposal>()
  async insert(proposal: MemoryWriteProposal): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    if (this.#proposals.has(parsed.proposalId)) return false
    this.#proposals.set(parsed.proposalId, structuredClone(parsed))
    return true
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
    if (this.#proposals.get(parsed.proposalId)?.version !== expectedVersion) return false
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

export interface MemoryWriteServiceOptions {
  repository: MemoryWriteProposalRepository
  provider?: MemoryProviderWriter
  interactionRepository: InteractionRepository
  now?: () => string
}

export class MemoryWriteService {
  readonly #repository: MemoryWriteProposalRepository
  readonly #provider: MemoryProviderWriter | undefined
  readonly #interactions: InteractionService
  readonly #interactionRepository: InteractionRepository
  readonly #now: () => string

  constructor(options: MemoryWriteServiceOptions) {
    this.#repository = options.repository
    this.#provider = options.provider
    this.#interactions = new InteractionService(options.interactionRepository)
    this.#interactionRepository = options.interactionRepository
    this.#now = options.now ?? (() => new Date().toISOString())
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
      if (existing.contentDigest === parsed.contentDigest) return existing
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
    if (policy.mode === 'approval_required') {
      const approval = ApprovalInputSchema.parse(approvalInput)
      if (policy.approvalPrincipalIds.length === 0) fail('MEMORY_APPROVAL_REQUIRED')
      await this.#interactions.request({
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
    if (!(await this.#repository.insert(proposal))) fail('MEMORY_PROPOSAL_CONFLICT')
    return proposal
  }

  async applyApproval(proposalId: string, observedAt: string): Promise<MemoryWriteProposal> {
    const proposal = await this.#get(proposalId)
    if (!proposal.approvalInteractionId) fail('MEMORY_APPROVAL_REQUIRED')
    const interaction = await this.#interactionRepository.get(proposal.approvalInteractionId)
    if (!interaction || interaction.state === 'pending') fail('MEMORY_APPROVAL_PENDING')
    if (
      interaction.state === 'expired' ||
      Date.parse(observedAt) >= Date.parse(interaction.expiresAt)
    )
      return this.#transition(proposal, 'expired', observedAt, 'expired')
    if (interaction.state !== 'responded' || !interaction.response) fail('MEMORY_APPROVAL_STALE')
    if (interaction.response.action === 'deny')
      return this.#transition(proposal, 'denied', observedAt, 'denied')
    if (interaction.response.action !== 'approve') fail('MEMORY_APPROVAL_STALE')
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
    if (
      proposal.provenance.expiresAt &&
      Date.parse(observedAt) >= Date.parse(proposal.provenance.expiresAt)
    )
      return this.#transition(proposal, 'expired', observedAt, 'expired')
    if (!['approved', 'reconciliation_required'].includes(proposal.state))
      fail(
        ['proposed', 'awaiting_approval'].includes(proposal.state)
          ? 'MEMORY_APPROVAL_REQUIRED'
          : 'MEMORY_PROPOSAL_TERMINAL'
      )
    const provider = this.#assertProvider()
    this.#assertScope(proposal, provider)
    const request = toWriteRequest(proposal)
    if (proposal.state === 'reconciliation_required') {
      if (!provider.capabilities.idempotentStatus) fail('MEMORY_WRITE_AMBIGUOUS')
      let status: Awaited<ReturnType<MemoryProviderWriter['status']>>
      try {
        status = await provider.status(request.idempotencyKey)
      } catch {
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

  #assertProvider(): MemoryProviderWriter {
    if (!this.#provider) fail('MEMORY_PROVIDER_ABSENT')
    if (!this.#provider.capabilities.writeCommit) fail('MEMORY_PROVIDER_READ_ONLY')
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

function fail(code: MemoryWriteErrorCode): never {
  throw new MemoryWriteError(code)
}

export const packageName = 'memory-writeback'

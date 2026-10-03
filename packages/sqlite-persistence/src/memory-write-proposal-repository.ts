import { createHash } from 'node:crypto'
import {
  compareCodePointOrder,
  MemoryWriteProposalSchema,
  type MemoryWriteProposal,
} from '@control-plane/contracts'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import { ExecutionSchema, type InteractionRequest } from '@control-plane/domain'
import {
  MemoryWriteError,
  parseMemoryWriteApproval,
  type MemoryWriteProposalRepository,
} from '@control-plane/memory-writeback'
import { SqliteInteractionRepository } from './interaction-repository.js'

const namespace = 'memory-write-proposals'
const dedupeNamespace = 'memory-write-dedupe'
const recordId = (value: string) => `r-${createHash('sha256').update(value).digest('hex')}`
const dedupeId = (workspaceId: string, hint: string) =>
  recordId(JSON.stringify([workspaceId, hint]))
const json = (proposal: MemoryWriteProposal): JsonValue =>
  JSON.parse(JSON.stringify(proposal)) as JsonValue

/** Durable proposal coordination only; provider-native memory remains provider-owned. */
export class SqliteMemoryWriteProposalRepository implements MemoryWriteProposalRepository {
  constructor(readonly provider: PersistenceProvider) {}

  insert(input: MemoryWriteProposal): Promise<boolean> {
    const proposal = MemoryWriteProposalSchema.parse(input)
    return this.provider.transaction((transaction) => this.#insert(transaction, proposal))
  }

  insertWithApproval(input: MemoryWriteProposal, approval: InteractionRequest): Promise<boolean> {
    const proposal = MemoryWriteProposalSchema.parse(input)
    const interaction = parseMemoryWriteApproval(proposal, approval)
    return this.provider.transaction(async (transaction) => {
      if (!(await this.#insert(transaction, proposal))) return false
      const owner = await transaction.get(
        'executions',
        recordId(proposal.provenance.sourceExecutionId)
      )
      if (
        !owner ||
        ExecutionSchema.parse(owner.value).correlation.workspaceId !== proposal.workspaceId
      )
        throw new Error('MEMORY_PROPOSAL_SCOPE_MISMATCH')
      const interactions = new SqliteInteractionRepository(this.provider)
      if (!(await interactions.insertInTransaction(transaction, interaction)))
        throw new MemoryWriteError('MEMORY_PROPOSAL_CONFLICT')
      return true
    })
  }

  async #insert(
    transaction: PersistenceTransaction,
    proposal: MemoryWriteProposal
  ): Promise<boolean> {
    const id = recordId(proposal.proposalId)
    const dedupe = dedupeId(proposal.workspaceId, proposal.dedupeHint)
    if ((await transaction.get(namespace, id)) || (await transaction.get(dedupeNamespace, dedupe)))
      return false
    await transaction.put({ namespace, id, value: json(proposal) })
    await transaction.put({
      namespace: dedupeNamespace,
      id: dedupe,
      value: { proposalId: proposal.proposalId },
    })
    return true
  }

  get(proposalId: string): Promise<MemoryWriteProposal | undefined> {
    MemoryWriteProposalSchema.shape.proposalId.parse(proposalId)
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(namespace, recordId(proposalId))
      return row ? MemoryWriteProposalSchema.parse(row.value) : undefined
    })
  }

  getByDedupe(workspaceId: string, hint: string): Promise<MemoryWriteProposal | undefined> {
    MemoryWriteProposalSchema.shape.workspaceId.parse(workspaceId)
    MemoryWriteProposalSchema.shape.dedupeHint.parse(hint)
    return this.provider.transaction(async (transaction) => {
      const index = await transaction.get(dedupeNamespace, dedupeId(workspaceId, hint))
      if (!index) return undefined
      const pointer = index.value as { proposalId?: unknown }
      const id = MemoryWriteProposalSchema.shape.proposalId.parse(pointer.proposalId)
      const row = await transaction.get(namespace, recordId(id))
      if (!row) throw new Error('SQLITE_MEMORY_PROPOSAL_INDEX_INCONSISTENT')
      const proposal = MemoryWriteProposalSchema.parse(row.value)
      if (proposal.workspaceId !== workspaceId || proposal.dedupeHint !== hint)
        throw new Error('SQLITE_MEMORY_PROPOSAL_INDEX_INCONSISTENT')
      return proposal
    })
  }

  compareAndSet(expectedVersion: number, input: MemoryWriteProposal): Promise<boolean> {
    const proposal = MemoryWriteProposalSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(proposal.proposalId)
      const row = await transaction.get(namespace, id)
      if (!row || MemoryWriteProposalSchema.parse(row.value).version !== expectedVersion)
        return false
      await transaction.put({
        namespace,
        id,
        expectedRevision: row.revision,
        value: json(proposal),
      })
      return true
    })
  }

  list(): Promise<MemoryWriteProposal[]> {
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespace))
        .map((row) => MemoryWriteProposalSchema.parse(row.value))
        .toSorted(
          (left, right) =>
            compareCodePointOrder(left.createdAt, right.createdAt) ||
            compareCodePointOrder(left.proposalId, right.proposalId)
        )
    )
  }
}

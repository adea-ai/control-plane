import { MemoryWriteProposalSchema, type MemoryWriteProposal } from '@control-plane/contracts'
import {
  assertMemoryWriteProposalIdentity,
  parseMemoryWriteApproval,
  MemoryWriteError,
  type MemoryWriteProposalRepository,
} from '@control-plane/memory-writeback'
import type { InteractionRequest } from '@control-plane/domain'
import { insertPostgresInteraction } from './interaction-repository.js'
import { executions, executionAttempts } from './schema/executions.js'
import { and, asc, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import type { DomainTransaction } from './transaction.js'
import { memoryWriteProposals } from './schema/memory-write-proposals.js'

export class PostgresMemoryWriteProposalRepository implements MemoryWriteProposalRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async insert(proposal: MemoryWriteProposal): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    return this.database.transaction((transaction) => this.#insert(transaction, parsed))
  }

  async #insert(transaction: DomainTransaction, parsed: MemoryWriteProposal): Promise<boolean> {
    const rows = await transaction
      .insert(memoryWriteProposals)
      .values(toRow(parsed))
      .onConflictDoNothing()
      .returning({ proposalId: memoryWriteProposals.proposalId })
    if (rows.length === 0) return false
    // Retention claims this owner FOR UPDATE before reading references. Holding
    // KEY SHARE through commit makes newly published JSON provenance visible first.
    const [owner] = await transaction
      .select({ workspaceId: executions.workspaceId })
      .from(executions)
      .where(eq(executions.executionId, parsed.provenance.sourceExecutionId))
      .for('key share')
      .limit(1)
    if (owner?.workspaceId !== parsed.workspaceId) throw new Error('MEMORY_PROPOSAL_SCOPE_MISMATCH')
    const [attempt] = await transaction
      .select({ executionId: executionAttempts.executionId })
      .from(executionAttempts)
      .where(eq(executionAttempts.attemptId, parsed.provenance.sourceAttemptId))
      .for('key share')
      .limit(1)
    if (attempt?.executionId !== parsed.provenance.sourceExecutionId)
      throw new Error('MEMORY_PROPOSAL_SCOPE_MISMATCH')
    return true
  }

  async insertWithApproval(
    proposal: MemoryWriteProposal,
    approval: InteractionRequest
  ): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    const interaction = parseMemoryWriteApproval(parsed, approval)
    return this.database.transaction(async (transaction) => {
      if (!(await this.#insert(transaction, parsed))) return false
      if (!(await insertPostgresInteraction(transaction, interaction)))
        throw new MemoryWriteError('MEMORY_PROPOSAL_CONFLICT')
      return true
    })
  }

  async get(proposalId: string): Promise<MemoryWriteProposal | undefined> {
    const [row] = await this.database
      .select()
      .from(memoryWriteProposals)
      .where(eq(memoryWriteProposals.proposalId, proposalId))
      .limit(1)
    return row ? MemoryWriteProposalSchema.parse(row.proposal) : undefined
  }

  async getByDedupe(workspaceId: string, dedupeHint: string) {
    const [row] = await this.database
      .select()
      .from(memoryWriteProposals)
      .where(
        and(
          eq(memoryWriteProposals.workspaceId, workspaceId),
          eq(memoryWriteProposals.dedupeHint, dedupeHint)
        )
      )
      .limit(1)
    return row ? MemoryWriteProposalSchema.parse(row.proposal) : undefined
  }

  async compareAndSet(expectedVersion: number, proposal: MemoryWriteProposal): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(memoryWriteProposals)
        .where(eq(memoryWriteProposals.proposalId, parsed.proposalId))
        .for('update')
        .limit(1)
      if (!row || row.version !== expectedVersion) return false
      const current = MemoryWriteProposalSchema.parse(row.proposal)
      assertMemoryWriteProposalIdentity(current, parsed)
      const rows = await transaction
        .update(memoryWriteProposals)
        .set(toUpdate(parsed))
        .where(
          and(
            eq(memoryWriteProposals.proposalId, parsed.proposalId),
            eq(memoryWriteProposals.version, expectedVersion)
          )
        )
        .returning({ proposalId: memoryWriteProposals.proposalId })
      return rows.length === 1
    })
  }

  async list(): Promise<MemoryWriteProposal[]> {
    const rows = await this.database
      .select()
      .from(memoryWriteProposals)
      .orderBy(asc(memoryWriteProposals.createdAt), asc(memoryWriteProposals.proposalId))
    return rows.map((row) => MemoryWriteProposalSchema.parse(row.proposal))
  }
}

function toRow(proposal: MemoryWriteProposal): typeof memoryWriteProposals.$inferInsert {
  return {
    proposalId: proposal.proposalId,
    workspaceId: proposal.workspaceId,
    dedupeHint: proposal.dedupeHint,
    state: proposal.state,
    version: proposal.version,
    proposal,
    createdAt: new Date(proposal.createdAt),
    updatedAt: new Date(proposal.updatedAt),
  }
}

function toUpdate(
  proposal: MemoryWriteProposal
): Partial<typeof memoryWriteProposals.$inferInsert> {
  return {
    state: proposal.state,
    version: proposal.version,
    proposal,
    updatedAt: new Date(proposal.updatedAt),
  }
}

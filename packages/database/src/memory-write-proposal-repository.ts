import { MemoryWriteProposalSchema, type MemoryWriteProposal } from '@control-plane/contracts'
import {
  parseMemoryWriteApproval,
  MemoryWriteError,
  type MemoryWriteProposalRepository,
} from '@control-plane/memory-writeback'
import type { InteractionRequest } from '@control-plane/domain'
import { insertPostgresInteraction } from './interaction-repository.js'
import { executions } from './schema/executions.js'
import { and, asc, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { memoryWriteProposals } from './schema/memory-write-proposals.js'

export class PostgresMemoryWriteProposalRepository implements MemoryWriteProposalRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async insert(proposal: MemoryWriteProposal): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    const rows = await this.database
      .insert(memoryWriteProposals)
      .values(toRow(parsed))
      .onConflictDoNothing()
      .returning({ proposalId: memoryWriteProposals.proposalId })
    return rows.length === 1
  }

  async insertWithApproval(
    proposal: MemoryWriteProposal,
    approval: InteractionRequest
  ): Promise<boolean> {
    const parsed = MemoryWriteProposalSchema.parse(proposal)
    const interaction = parseMemoryWriteApproval(parsed, approval)
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(memoryWriteProposals)
        .values(toRow(parsed))
        .onConflictDoNothing()
        .returning({ proposalId: memoryWriteProposals.proposalId })
      if (inserted.length === 0) return false
      const [owner] = await transaction
        .select({ workspaceId: executions.workspaceId })
        .from(executions)
        .where(eq(executions.executionId, parsed.provenance.sourceExecutionId))
        .for('key share')
        .limit(1)
      if (owner?.workspaceId !== parsed.workspaceId)
        throw new Error('MEMORY_PROPOSAL_SCOPE_MISMATCH')
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
    const rows = await this.database
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

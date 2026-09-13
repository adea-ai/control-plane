import { isDeepStrictEqual } from 'node:util'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  AppliedStateMutationSchema,
  ProjectStateSchema,
  StatePromotionProposalSchema,
  type AppliedStateMutation,
  type ProjectState,
  type ProjectStateRepository,
  type StatePromotionProposal,
  type StatePromotionProposalRepository,
} from '@control-plane/domain'
import { and, asc, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { outboxEvents } from './schema/messaging.js'
import {
  projectStateMutations,
  projectStateRevisions,
  projectStates,
  statePromotionProposals,
} from './schema/project-state.js'

export class PostgresProjectStateRepository implements ProjectStateRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async create(input: ProjectState): Promise<boolean> {
    const state = ProjectStateSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(projectStates)
        .values(toCurrentRow(state))
        .onConflictDoNothing()
        .returning({ projectId: projectStates.projectId })
      if (inserted.length === 0) return false
      await transaction.insert(projectStateRevisions).values(toRevisionRow(state))
      return true
    })
  }

  async get(workspaceId: string, projectId: string): Promise<ProjectState | undefined> {
    const scope = parseScope(workspaceId, projectId)
    const [row] = await this.database
      .select()
      .from(projectStates)
      .where(scopeWhere(projectStates, scope))
      .limit(1)
    return row ? stateFromRow(row) : undefined
  }

  async getAtRevision(
    workspaceId: string,
    projectId: string,
    revision: number
  ): Promise<ProjectState | undefined> {
    const scope = parseScope(workspaceId, projectId)
    const [row] = await this.database
      .select()
      .from(projectStateRevisions)
      .where(
        and(
          scopeWhere(projectStateRevisions, scope),
          eq(projectStateRevisions.revision, parseRevision(revision))
        )
      )
      .limit(1)
    return row ? revisionFromRow(row) : undefined
  }

  async getHistory(workspaceId: string, projectId: string): Promise<readonly ProjectState[]> {
    const scope = parseScope(workspaceId, projectId)
    const rows = await this.database
      .select()
      .from(projectStateRevisions)
      .where(scopeWhere(projectStateRevisions, scope))
      .orderBy(asc(projectStateRevisions.revision))
    return rows.map(revisionFromRow)
  }

  async getMutation(
    workspaceId: string,
    projectId: string,
    mutationId: string
  ): Promise<AppliedStateMutation | undefined> {
    const scope = parseScope(workspaceId, projectId)
    const parsedMutationId = IdentifierSchemas.stateMutationId.parse(mutationId)
    const [row] = await this.database
      .select()
      .from(projectStateMutations)
      .where(
        and(
          scopeWhere(projectStateMutations, scope),
          eq(projectStateMutations.mutationId, parsedMutationId)
        )
      )
      .limit(1)
    return row ? mutationFromRow(row) : undefined
  }

  async compareAndSet(
    expectedRevision: number,
    stateInput: ProjectState,
    mutationInput: AppliedStateMutation
  ): Promise<boolean> {
    const expected = parseRevision(expectedRevision)
    const state = ProjectStateSchema.parse(stateInput)
    const mutation = AppliedStateMutationSchema.parse(mutationInput)
    if (state.revision !== expected + 1 || mutation.resultingRevision !== state.revision) {
      throw new Error('PROJECT_STATE_MUTATION_INTEGRITY_ERROR')
    }
    const current = await this.get(state.workspaceId, state.projectId)
    if (!current || current.createdAt !== state.createdAt) return false
    return this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(projectStates)
        .set(toCurrentUpdate(state))
        .where(and(scopeWhere(projectStates, state), eq(projectStates.revision, expected)))
        .returning({ projectId: projectStates.projectId })
      if (updated.length === 0) return false
      await transaction.insert(projectStateRevisions).values(toRevisionRow(state))
      await transaction.insert(projectStateMutations).values({
        workspaceId: state.workspaceId,
        projectId: state.projectId,
        ...mutation,
      })
      // Durable product event in the same transaction as the revision write: the event
      // exists exactly when the new revision commits, and never for a rejected CAS.
      await transaction.insert(outboxEvents).values({
        aggregateType: 'project_state',
        aggregateId: `${state.workspaceId}:${state.projectId}`,
        eventType: 'project_state.updated',
        payload: {
          workspaceId: state.workspaceId,
          projectId: state.projectId,
          previousRevision: expected,
          revision: state.revision,
          mutationId: mutation.mutationId,
          inputDigest: mutation.inputDigest,
          touchedItemIds: [...mutation.touchedItemIds],
        },
      })
      return true
    })
  }
}

export class PostgresStatePromotionProposalRepository implements StatePromotionProposalRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async insert(input: StatePromotionProposal): Promise<boolean> {
    const proposal = StatePromotionProposalSchema.parse(input)
    const inserted = await this.database
      .insert(statePromotionProposals)
      .values(toProposalRow(proposal))
      .onConflictDoNothing()
      .returning({ proposalId: statePromotionProposals.proposalId })
    return inserted.length === 1
  }

  async get(proposalId: string): Promise<StatePromotionProposal | undefined> {
    const parsedId = IdentifierSchemas.statePromotionProposalId.parse(proposalId)
    const [row] = await this.database
      .select()
      .from(statePromotionProposals)
      .where(eq(statePromotionProposals.proposalId, parsedId))
      .limit(1)
    return row ? proposalFromRow(row) : undefined
  }

  async compareAndSet(expectedRevision: number, input: StatePromotionProposal): Promise<boolean> {
    const expected = parsePositiveRevision(expectedRevision)
    const proposal = StatePromotionProposalSchema.parse(input)
    if (proposal.revision !== expected + 1) {
      throw new Error('STATE_PROMOTION_PROPOSAL_INTEGRITY_ERROR')
    }
    const current = await this.get(proposal.proposalId)
    if (
      !current ||
      current.workspaceId !== proposal.workspaceId ||
      current.projectId !== proposal.projectId ||
      current.baseRevision !== proposal.baseRevision ||
      current.sourceExecutionId !== proposal.sourceExecutionId ||
      current.createdAt !== proposal.createdAt ||
      current.expiresAt !== proposal.expiresAt ||
      !isDeepStrictEqual(current.operations, proposal.operations)
    ) {
      return false
    }
    const updated = await this.database
      .update(statePromotionProposals)
      .set(toProposalUpdate(proposal))
      .where(
        and(
          eq(statePromotionProposals.proposalId, proposal.proposalId),
          eq(statePromotionProposals.revision, expected)
        )
      )
      .returning({ proposalId: statePromotionProposals.proposalId })
    return updated.length === 1
  }
}

type Scope = { readonly workspaceId: string; readonly projectId: string }
type CurrentRow = typeof projectStates.$inferSelect
type RevisionRow = typeof projectStateRevisions.$inferSelect
type MutationRow = typeof projectStateMutations.$inferSelect
type ProposalRow = typeof statePromotionProposals.$inferSelect

function parseScope(workspaceId: string, projectId: string): Scope {
  return {
    workspaceId: IdentifierSchemas.workspaceId.parse(workspaceId),
    projectId: IdentifierSchemas.projectId.parse(projectId),
  }
}

function scopeWhere(
  table: typeof projectStates | typeof projectStateRevisions | typeof projectStateMutations,
  scope: Scope
) {
  return and(eq(table.workspaceId, scope.workspaceId), eq(table.projectId, scope.projectId))
}

function parseRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('INVALID_PROJECT_REVISION')
  return revision
}

function parsePositiveRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('INVALID_PROPOSAL_REVISION')
  return revision
}

function toCurrentRow(state: ProjectState): typeof projectStates.$inferInsert {
  return {
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    revision: state.revision,
    state,
    createdAt: new Date(state.createdAt),
    updatedAt: new Date(state.updatedAt),
  }
}

function toCurrentUpdate(state: ProjectState): Partial<typeof projectStates.$inferInsert> {
  return { revision: state.revision, state, updatedAt: new Date(state.updatedAt) }
}

function toRevisionRow(state: ProjectState): typeof projectStateRevisions.$inferInsert {
  return {
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    revision: state.revision,
    state,
    recordedAt: new Date(state.updatedAt),
  }
}

function stateFromRow(row: CurrentRow): ProjectState {
  const state = ProjectStateSchema.parse(row.state)
  if (
    state.workspaceId !== row.workspaceId ||
    state.projectId !== row.projectId ||
    state.revision !== row.revision ||
    state.createdAt !== row.createdAt.toISOString() ||
    state.updatedAt !== row.updatedAt.toISOString()
  ) {
    throw new Error('PROJECT_STATE_ROW_INTEGRITY_ERROR')
  }
  return state
}

function revisionFromRow(row: RevisionRow): ProjectState {
  const state = ProjectStateSchema.parse(row.state)
  if (
    state.workspaceId !== row.workspaceId ||
    state.projectId !== row.projectId ||
    state.revision !== row.revision ||
    state.updatedAt !== row.recordedAt.toISOString()
  ) {
    throw new Error('PROJECT_STATE_REVISION_INTEGRITY_ERROR')
  }
  return state
}

function mutationFromRow(row: MutationRow): AppliedStateMutation {
  return AppliedStateMutationSchema.parse({
    mutationId: row.mutationId,
    inputDigest: row.inputDigest,
    resultingRevision: row.resultingRevision,
    touchedItemIds: row.touchedItemIds,
  })
}

function toProposalRow(
  proposal: StatePromotionProposal
): typeof statePromotionProposals.$inferInsert {
  return {
    proposalId: proposal.proposalId,
    workspaceId: proposal.workspaceId,
    projectId: proposal.projectId,
    revision: proposal.revision,
    state: proposal.state,
    proposal,
    createdAt: new Date(proposal.createdAt),
    updatedAt: proposalUpdatedAt(proposal),
  }
}

function toProposalUpdate(
  proposal: StatePromotionProposal
): Partial<typeof statePromotionProposals.$inferInsert> {
  return {
    revision: proposal.revision,
    state: proposal.state,
    proposal,
    updatedAt: proposalUpdatedAt(proposal),
  }
}

function proposalFromRow(row: ProposalRow): StatePromotionProposal {
  const proposal = StatePromotionProposalSchema.parse(row.proposal)
  if (
    proposal.proposalId !== row.proposalId ||
    proposal.workspaceId !== row.workspaceId ||
    proposal.projectId !== row.projectId ||
    proposal.revision !== row.revision ||
    proposal.state !== row.state ||
    proposal.createdAt !== row.createdAt.toISOString() ||
    !isDeepStrictEqual(proposalUpdatedAt(proposal), row.updatedAt)
  ) {
    throw new Error('STATE_PROMOTION_PROPOSAL_ROW_INTEGRITY_ERROR')
  }
  return proposal
}

function proposalUpdatedAt(proposal: StatePromotionProposal): Date {
  return new Date(
    proposal.expiredAt ??
      proposal.supersededAt ??
      proposal.mergedAt ??
      proposal.reviewedAt ??
      proposal.createdAt
  )
}

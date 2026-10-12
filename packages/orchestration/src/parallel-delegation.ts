import { deriveContextPackage, type ContextPackage } from '@control-plane/context'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  ProjectStateOperationSchema,
  type ProjectStateOperation,
  type ProjectStateService,
  type StatePromotionProposal,
} from '@control-plane/domain'
import { z } from 'zod'
import type { DelegationRecord, DelegationService } from './delegation.js'

const TimestampSchema = z.iso.datetime()
const ParentPlanSchema = z
  .object({
    profile: z.object({ profileVersionId: IdentifierSchemas.profileVersionId }).passthrough(),
    constraints: z
      .object({
        limits: z
          .object({
            budget: z.object({
              currency: z.literal('USD'),
              maximumMicrounits: z.number().int().positive(),
            }),
            tokens: z.object({ maximumTotal: z.number().int().positive() }),
            duration: z.object({ maximumMs: z.number().int().positive() }),
            concurrency: z.object({ maximumParallel: z.number().int().positive() }),
            childExecutions: z.object({
              maximumTotal: z.number().int().nonnegative(),
              maximumDepth: z.number().int().nonnegative(),
            }),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

const BranchSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId,
    role: z.string().min(1).max(256),
    objective: z.string().min(1).max(8_192),
    context: z.object({
      allowedStateItemIds: z.array(IdentifierSchemas.projectStateItemId),
      allowedArtifactIds: z.array(IdentifierSchemas.artifactId),
      maximumBytes: z.number().int().positive(),
      maximumTokens: z.number().int().positive(),
      successCriteria: z.array(z.string().min(1)).min(1),
      returnContractRef: z.string().min(1).max(512),
    }),
    childPlan: z
      .object({
        constraints: z
          .object({
            limits: z
              .object({
                budget: z.object({ maximumMicrounits: z.number().int().positive() }).passthrough(),
                tokens: z.object({ maximumTotal: z.number().int().positive() }),
                duration: z.object({ maximumMs: z.number().int().positive() }),
              })
              .passthrough(),
          })
          .passthrough(),
        compiledAt: TimestampSchema,
      })
      .passthrough(),
    policy: z.unknown(),
    runtime: z.object({
      runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
      runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId.optional(),
      runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.optional(),
    }),
  })
  .strict()

export type ParallelDelegationErrorCode =
  | 'EMPTY_DELEGATION_GROUP'
  | 'PARALLEL_LIMIT_EXCEEDED'
  | 'AGGREGATE_BUDGET_EXCEEDED'
  | 'AGGREGATE_TOKEN_LIMIT_EXCEEDED'
  | 'CHILD_DURATION_EXCEEDED'
  | 'DELEGATION_GROUP_INCOMPLETE'
  | 'PROMOTION_PROVENANCE_MISMATCH'

export class ParallelDelegationError extends Error {
  constructor(readonly code: ParallelDelegationErrorCode) {
    super(code)
    this.name = 'ParallelDelegationError'
  }
}

export interface ParallelDelegationBranch {
  readonly record: DelegationRecord
  readonly contextPackage: ContextPackage
}

export class ParallelDelegationCoordinator {
  readonly #delegations: Pick<
    DelegationService,
    'delegate' | 'deriveChildPlan' | 'dispatchChild' | 'listChildren'
  >
  readonly #projectState: Pick<ProjectStateService, 'createPromotionProposal'>

  readonly #contexts:
    | {
        put(contextPackage: ReturnType<typeof deriveContextPackage>): Promise<unknown>
      }
    | undefined

  constructor(options: {
    readonly delegations: Pick<
      DelegationService,
      'delegate' | 'deriveChildPlan' | 'dispatchChild' | 'listChildren'
    >
    readonly projectState: Pick<ProjectStateService, 'createPromotionProposal'>
    /**
     * Optional persistence port for the derived per-branch context packages.
     * Durable plan repositories reject a plan whose context package is not
     * retained, so a composition backed by SQLite (or any validating store)
     * passes its context repository here; in-memory compositions may omit it.
     * The coordinator still derives the packages itself — owners never
     * pre-supply or substitute them.
     */
    readonly contexts?: {
      put(contextPackage: ReturnType<typeof deriveContextPackage>): Promise<unknown>
    }
  }) {
    this.#delegations = options.delegations
    this.#projectState = options.projectState
    this.#contexts = options.contexts
  }

  async fanOut(input: {
    readonly delegationGroupId: string
    readonly parentExecutionId: string
    readonly parentPlan: unknown
    readonly parentContextPackage: unknown
    readonly acceptedAt: string
    readonly deadlineAt?: string
    readonly branches: readonly unknown[]
  }): Promise<readonly ParallelDelegationBranch[]> {
    const delegationGroupId = IdentifierSchemas.delegationGroupId.parse(input.delegationGroupId)
    const parentExecutionId = IdentifierSchemas.executionId.parse(input.parentExecutionId)
    const acceptedAt = TimestampSchema.parse(input.acceptedAt)
    const deadlineAt = input.deadlineAt ? TimestampSchema.parse(input.deadlineAt) : undefined
    const parentPlan = ParentPlanSchema.parse(input.parentPlan)
    const branches = z.array(BranchSchema).max(256).parse(input.branches)
    if (branches.length === 0) throw new ParallelDelegationError('EMPTY_DELEGATION_GROUP')
    if (
      branches.length > parentPlan.constraints.limits.concurrency.maximumParallel ||
      branches.length > parentPlan.constraints.limits.childExecutions.maximumTotal
    ) {
      throw new ParallelDelegationError('PARALLEL_LIMIT_EXCEEDED')
    }
    const allocatedCost = branches.reduce(
      (sum, branch) => sum + branch.childPlan.constraints.limits.budget.maximumMicrounits,
      0
    )
    if (allocatedCost > parentPlan.constraints.limits.budget.maximumMicrounits) {
      throw new ParallelDelegationError('AGGREGATE_BUDGET_EXCEEDED')
    }
    const allocatedTokens = branches.reduce(
      (sum, branch) => sum + branch.childPlan.constraints.limits.tokens.maximumTotal,
      0
    )
    if (allocatedTokens > parentPlan.constraints.limits.tokens.maximumTotal) {
      throw new ParallelDelegationError('AGGREGATE_TOKEN_LIMIT_EXCEEDED')
    }
    if (
      branches.some(
        (branch) =>
          branch.childPlan.constraints.limits.duration.maximumMs >
          parentPlan.constraints.limits.duration.maximumMs
      )
    ) {
      throw new ParallelDelegationError('CHILD_DURATION_EXCEEDED')
    }

    const prepared = branches.map((branch) => {
      const contextPackage = deriveContextPackage(input.parentContextPackage, {
        objective: branch.objective,
        allowedStateItemIds: branch.context.allowedStateItemIds,
        allowedArtifactIds: branch.context.allowedArtifactIds,
        budgets: {
          maximumBytes: branch.context.maximumBytes,
          maximumTokens: branch.context.maximumTokens,
        },
        successCriteria: branch.context.successCriteria,
        returnContract: { contractRef: branch.context.returnContractRef },
        compiledAt: branch.childPlan.compiledAt,
      })
      return { branch, contextPackage }
    })
    for (const { branch, contextPackage } of prepared) {
      this.#delegations.deriveChildPlan(input.parentPlan, {
        ...branch.childPlan,
        contextPackage,
      })
    }

    const results: ParallelDelegationBranch[] = []
    for (const { branch, contextPackage } of prepared) {
      // Retain the derived context before the child plan is persisted, so a
      // validating (durable) plan repository finds its context package.
      await this.#contexts?.put(contextPackage)
      await this.#delegations.delegate({
        delegationId: branch.delegationId,
        delegationGroupId,
        parentExecutionId,
        childExecutionId: branch.childExecutionId,
        role: branch.role,
        profileVersionId: parentPlan.profile.profileVersionId,
        objective: branch.objective,
        parentPlan: input.parentPlan,
        childPlan: { ...branch.childPlan, contextPackage },
        policy: branch.policy,
        acceptedAt,
        ...(deadlineAt ? { deadlineAt } : {}),
      })
      const dispatched = await this.#delegations.dispatchChild({
        delegationId: branch.delegationId,
        childAttemptId: branch.childAttemptId,
        runtime: branch.runtime,
        dispatchedAt: acceptedAt,
      })
      results.push({ record: dispatched.record, contextPackage })
    }
    return results
  }

  async fanIn(input: {
    readonly parentExecutionId: string
    readonly delegationGroupId: string
    readonly allowPartial: boolean
  }): Promise<{
    readonly completed: readonly DelegationRecord[]
    readonly failed: readonly DelegationRecord[]
    readonly artifactRefs: readonly string[]
  }> {
    const groupId = IdentifierSchemas.delegationGroupId.parse(input.delegationGroupId)
    const children = (await this.#delegations.listChildren(input.parentExecutionId)).filter(
      ({ delegationGroupId }) => delegationGroupId === groupId
    )
    if (children.some(({ state }) => !['completed', 'failed', 'cancelled'].includes(state))) {
      throw new ParallelDelegationError('DELEGATION_GROUP_INCOMPLETE')
    }
    const completed = children.filter(({ state }) => state === 'completed')
    const failed = children.filter(({ state }) => state !== 'completed')
    if (!input.allowPartial && failed.length > 0) {
      throw new ParallelDelegationError('DELEGATION_GROUP_INCOMPLETE')
    }
    return {
      completed,
      failed,
      artifactRefs: completed.flatMap(({ terminalResultRef }) =>
        terminalResultRef ? [terminalResultRef] : []
      ),
    }
  }

  async createPromotion(input: {
    readonly proposalId: string
    readonly workspaceId: string
    readonly projectId: string
    readonly baseRevision: number
    readonly child: DelegationRecord
    readonly operations: readonly ProjectStateOperation[]
    readonly createdAt: string
    readonly expiresAt: string
  }): Promise<StatePromotionProposal> {
    if (input.child.state !== 'completed') {
      throw new ParallelDelegationError('PROMOTION_PROVENANCE_MISMATCH')
    }
    const operations = z.array(ProjectStateOperationSchema).min(1).max(256).parse(input.operations)
    for (const operation of operations) {
      const provenance =
        operation.kind === 'append' ? operation.item.provenance : operation.provenance
      if (
        provenance.sourceKind !== 'execution' ||
        provenance.sourceExecutionId !== input.child.childExecutionId ||
        provenance.executionPlan?.executionPlanId !== input.child.childExecutionPlanId ||
        provenance.executionPlan.contentDigest !== input.child.childExecutionPlanDigest ||
        provenance.contextPackage?.contextPackageId !== input.child.contextPackageId ||
        provenance.contextPackage.contentDigest !== input.child.contextPackageDigest
      ) {
        throw new ParallelDelegationError('PROMOTION_PROVENANCE_MISMATCH')
      }
    }
    return this.#projectState.createPromotionProposal({
      proposalId: input.proposalId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      sourceExecutionId: input.child.childExecutionId,
      operations,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    })
  }
}

export function findPromotionConflicts(
  proposals: readonly Pick<StatePromotionProposal, 'proposalId' | 'operations'>[]
): readonly {
  readonly leftProposalId: string
  readonly rightProposalId: string
  readonly target: string
}[] {
  const writes: { proposalId: string; target: string }[] = []
  for (const proposal of proposals) {
    for (const operation of proposal.operations) {
      writes.push({
        proposalId: proposal.proposalId,
        target:
          operation.kind === 'append' ? `key:${operation.item.key}` : `item:${operation.itemId}`,
      })
    }
  }
  return writes.flatMap((left, index) =>
    writes.slice(index + 1).flatMap((right) =>
      left.proposalId !== right.proposalId && left.target === right.target
        ? [
            {
              leftProposalId: left.proposalId,
              rightProposalId: right.proposalId,
              target: left.target,
            },
          ]
        : []
    )
  )
}

import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const PrincipalRefSchema = z.string().min(1).max(256)
const ItemKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9._-]*$/)

export const StateItemProvenanceSchema = z
  .object({
    sourceKind: z.enum(['principal', 'execution', 'artifact', 'system']),
    sourcePrincipalRef: PrincipalRefSchema.optional(),
    sourceExecutionId: IdentifierSchemas.executionId.optional(),
    artifactRefs: z.array(IdentifierSchemas.artifactId).max(128),
    executionPlan: z
      .object({
        executionPlanId: IdentifierSchemas.executionPlanId,
        contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .optional(),
    contextPackage: z
      .object({
        contextPackageId: IdentifierSchemas.contextPackageId,
        contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .optional(),
    capturedAt: TimestampSchema,
  })
  .superRefine((value, context) => {
    if (
      value.sourceKind === 'execution' &&
      (!value.sourceExecutionId || !value.sourcePrincipalRef)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Execution provenance requires sourceExecutionId and sourcePrincipalRef',
      })
    }
    if (value.sourceKind === 'principal' && !value.sourcePrincipalRef) {
      context.addIssue({
        code: 'custom',
        message: 'Principal provenance requires sourcePrincipalRef',
      })
    }
    if (value.sourceKind === 'artifact' && value.artifactRefs.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact provenance requires an Artifact reference',
      })
    }
  })

export const StateItemFreshnessSchema = z
  .object({
    observedAt: TimestampSchema,
    expiresAt: TimestampSchema.optional(),
  })
  .refine((value) => !value.expiresAt || isAfter(value.expiresAt, value.observedAt), {
    message: 'State item expiry must be after observation',
  })

const StateItemInputSchema = z.object({
  itemId: IdentifierSchemas.projectStateItemId,
  key: ItemKeySchema,
  value: z.json(),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
  freshness: StateItemFreshnessSchema,
  provenance: StateItemProvenanceSchema,
  supersedesItemId: IdentifierSchemas.projectStateItemId.optional(),
})

export const ProjectStateItemSchema = StateItemInputSchema.extend({
  itemRevision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).refine((item) => !isAfter(item.createdAt, item.updatedAt), {
  message: 'ProjectState item update cannot predate creation',
})

export const ProjectStateOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('append'), item: StateItemInputSchema }),
  z.object({
    kind: z.literal('update'),
    itemId: IdentifierSchemas.projectStateItemId,
    expectedItemRevision: z.number().int().positive(),
    value: z.json(),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
    freshness: StateItemFreshnessSchema,
    provenance: StateItemProvenanceSchema,
    supersedesItemId: IdentifierSchemas.projectStateItemId.optional(),
  }),
])

export const ProjectStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
    revision: z.number().int().nonnegative(),
    items: z
      .array(ProjectStateItemSchema)
      .max(10_000)
      .refine((items) => new Set(items.map((item) => item.itemId)).size === items.length, {
        message: 'ProjectState item IDs must be unique',
      })
      .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
        message: 'ProjectState item keys must be unique',
      }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine((state) => !isAfter(state.createdAt, state.updatedAt), {
    message: 'ProjectState update cannot predate creation',
  })

export const StatePromotionProposalSchema = z
  .object({
    proposalId: IdentifierSchemas.statePromotionProposalId,
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
    revision: z.number().int().positive(),
    baseRevision: z.number().int().nonnegative(),
    sourceExecutionId: IdentifierSchemas.executionId,
    operations: z.array(ProjectStateOperationSchema).min(1).max(256),
    state: z.enum(['candidate', 'approved', 'rejected', 'merged', 'superseded', 'expired']),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    reviewedAt: TimestampSchema.optional(),
    reviewingPrincipalRef: PrincipalRefSchema.optional(),
    reviewReason: z.string().min(1).max(1_024).optional(),
    mergedAt: TimestampSchema.optional(),
    resultingProjectStateRevision: z.number().int().positive().optional(),
    supersededAt: TimestampSchema.optional(),
    supersededByProposalId: IdentifierSchemas.statePromotionProposalId.optional(),
    expiredAt: TimestampSchema.optional(),
  })
  .refine((proposal) => isAfter(proposal.expiresAt, proposal.createdAt), {
    message: 'Promotion expiry must be after creation',
  })
  .superRefine((proposal, context) => {
    if (
      ['approved', 'rejected', 'merged'].includes(proposal.state) &&
      (!proposal.reviewedAt || !proposal.reviewingPrincipalRef)
    ) {
      context.addIssue({ code: 'custom', message: 'Reviewed proposals require reviewer metadata' })
    }
    if (
      proposal.state === 'merged' &&
      (!proposal.mergedAt || !proposal.resultingProjectStateRevision)
    ) {
      context.addIssue({ code: 'custom', message: 'Merged proposals require resulting revision' })
    }
    if (
      proposal.state === 'superseded' &&
      (!proposal.supersededAt || !proposal.supersededByProposalId)
    ) {
      context.addIssue({ code: 'custom', message: 'Superseded proposals require a successor' })
    }
    if (proposal.state === 'expired' && !proposal.expiredAt) {
      context.addIssue({ code: 'custom', message: 'Expired proposals require expiry metadata' })
    }
  })

export type ProjectState = z.output<typeof ProjectStateSchema>
export type ProjectStateItem = z.output<typeof ProjectStateItemSchema>
export type ProjectStateOperation = z.output<typeof ProjectStateOperationSchema>
export type StatePromotionProposal = z.output<typeof StatePromotionProposalSchema>

export const AppliedStateMutationSchema = z.object({
  mutationId: IdentifierSchemas.stateMutationId,
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resultingRevision: z.number().int().positive(),
  touchedItemIds: z.array(IdentifierSchemas.projectStateItemId).max(256),
})

export type AppliedStateMutation = z.output<typeof AppliedStateMutationSchema>

export interface ProjectStateRepository {
  create(state: ProjectState): Promise<boolean>
  get(workspaceId: string, projectId: string): Promise<ProjectState | undefined>
  getAtRevision(
    workspaceId: string,
    projectId: string,
    revision: number
  ): Promise<ProjectState | undefined>
  getHistory(workspaceId: string, projectId: string): Promise<readonly ProjectState[]>
  getMutation(
    workspaceId: string,
    projectId: string,
    mutationId: string
  ): Promise<AppliedStateMutation | undefined>
  compareAndSet(
    expectedRevision: number,
    state: ProjectState,
    mutation: AppliedStateMutation
  ): Promise<boolean>
}

export interface StatePromotionProposalRepository {
  insert(proposal: StatePromotionProposal): Promise<boolean>
  get(proposalId: string): Promise<StatePromotionProposal | undefined>
  compareAndSet(expectedRevision: number, proposal: StatePromotionProposal): Promise<boolean>
}

export interface ProjectStateChangedEvent {
  readonly type: 'project_state.changed'
  readonly workspaceId: string
  readonly projectId: string
  readonly revision: number
  readonly mutationId: string
  readonly actorPrincipalRef: string
  readonly occurredAt: string
}

export interface ProjectStateEventPublisher {
  publish(event: ProjectStateChangedEvent): Promise<void>
}

export class RecordingProjectStateEventPublisher implements ProjectStateEventPublisher {
  readonly events: ProjectStateChangedEvent[] = []

  async publish(event: ProjectStateChangedEvent): Promise<void> {
    this.events.push(clone(event))
  }
}

export class InMemoryProjectStateRepository implements ProjectStateRepository {
  readonly #states = new Map<string, ProjectState>()
  readonly #history = new Map<string, ProjectState[]>()
  readonly #mutations = new Map<string, AppliedStateMutation>()

  async create(state: ProjectState): Promise<boolean> {
    const key = stateKey(state.workspaceId, state.projectId)
    if (this.#states.has(key)) return false
    this.#states.set(key, clone(state))
    this.#history.set(key, [clone(state)])
    return true
  }

  async get(workspaceId: string, projectId: string): Promise<ProjectState | undefined> {
    return cloneOptional(this.#states.get(stateKey(workspaceId, projectId)))
  }

  async getAtRevision(
    workspaceId: string,
    projectId: string,
    revision: number
  ): Promise<ProjectState | undefined> {
    return cloneOptional(
      this.#history
        .get(stateKey(workspaceId, projectId))
        ?.find((state) => state.revision === revision)
    )
  }

  async getHistory(workspaceId: string, projectId: string): Promise<readonly ProjectState[]> {
    return (this.#history.get(stateKey(workspaceId, projectId)) ?? []).map(clone)
  }

  async getMutation(
    workspaceId: string,
    projectId: string,
    mutationId: string
  ): Promise<AppliedStateMutation | undefined> {
    return cloneOptional(this.#mutations.get(mutationKey(workspaceId, projectId, mutationId)))
  }

  async compareAndSet(
    expectedRevision: number,
    state: ProjectState,
    mutation: AppliedStateMutation
  ): Promise<boolean> {
    const key = stateKey(state.workspaceId, state.projectId)
    if (this.#states.get(key)?.revision !== expectedRevision) return false
    this.#states.set(key, clone(state))
    this.#history.get(key)?.push(clone(state))
    this.#mutations.set(
      mutationKey(state.workspaceId, state.projectId, mutation.mutationId),
      clone(mutation)
    )
    return true
  }
}

export class InMemoryStatePromotionProposalRepository implements StatePromotionProposalRepository {
  readonly #proposals = new Map<string, StatePromotionProposal>()

  async insert(proposal: StatePromotionProposal): Promise<boolean> {
    if (this.#proposals.has(proposal.proposalId)) return false
    this.#proposals.set(proposal.proposalId, clone(proposal))
    return true
  }

  async get(proposalId: string): Promise<StatePromotionProposal | undefined> {
    return cloneOptional(this.#proposals.get(proposalId))
  }

  async compareAndSet(
    expectedRevision: number,
    proposal: StatePromotionProposal
  ): Promise<boolean> {
    if (this.#proposals.get(proposal.proposalId)?.revision !== expectedRevision) return false
    this.#proposals.set(proposal.proposalId, clone(proposal))
    return true
  }
}

export type ProjectStateErrorCode =
  | 'PROJECT_STATE_EXISTS'
  | 'PROJECT_STATE_MISSING'
  | 'MUTATION_ID_REUSED'
  | 'PROMOTION_REQUIRED'
  | 'ITEM_ALREADY_EXISTS'
  | 'ITEM_MISSING'
  | 'ITEM_REVISION_CONFLICT'
  | 'PROPOSAL_EXISTS'
  | 'PROPOSAL_MISSING'
  | 'PROPOSAL_STATE_CONFLICT'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_NOT_EXPIRED'
  | 'REVISION_MISSING'
  | 'TIMESTAMP_REGRESSION'

export class ProjectStateError extends Error {
  constructor(readonly code: ProjectStateErrorCode) {
    super(code)
    this.name = 'ProjectStateError'
  }
}

export class ProjectStateConflict extends Error {
  readonly code = 'STALE_REVISION'
  readonly conflictingItemIds: readonly string[]

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
    conflicts: readonly string[]
  ) {
    super('STALE_REVISION')
    this.name = 'ProjectStateConflict'
    this.conflictingItemIds = conflicts
  }
}

const MutationInputSchema = z.object({
  mutationId: IdentifierSchemas.stateMutationId,
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  expectedRevision: z.number().int().nonnegative(),
  actorPrincipalRef: PrincipalRefSchema,
  operations: z.array(ProjectStateOperationSchema).min(1).max(256),
  at: TimestampSchema,
})

const PromotionProposalInputSchema = z.object({
  proposalId: IdentifierSchemas.statePromotionProposalId,
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  baseRevision: z.number().int().nonnegative(),
  sourceExecutionId: IdentifierSchemas.executionId,
  operations: z.array(ProjectStateOperationSchema).min(1).max(256),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
})

export class ProjectStateService {
  constructor(
    readonly repository: ProjectStateRepository,
    readonly proposals: StatePromotionProposalRepository,
    readonly events: ProjectStateEventPublisher
  ) {}

  async initialize(input: unknown): Promise<ProjectState> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        projectId: IdentifierSchemas.projectId,
        at: TimestampSchema,
      })
      .parse(input)
    const state = ProjectStateSchema.parse({
      schemaVersion: 1,
      ...parsed,
      revision: 0,
      items: [],
      createdAt: parsed.at,
      updatedAt: parsed.at,
    })
    if (!(await this.repository.create(state))) throw new ProjectStateError('PROJECT_STATE_EXISTS')
    return state
  }

  async applyMutation(input: unknown): Promise<{ state: ProjectState; applied: boolean }> {
    return this.#applyMutation(input, false)
  }

  async #applyMutation(
    input: unknown,
    allowExecutionProvenance: boolean
  ): Promise<{ state: ProjectState; applied: boolean }> {
    const mutation = MutationInputSchema.parse(input)
    if (
      !allowExecutionProvenance &&
      mutation.operations.some(
        (operation) => operationProvenance(operation).sourceKind === 'execution'
      )
    ) {
      throw new ProjectStateError('PROMOTION_REQUIRED')
    }
    const inputDigest = digest(mutation)
    const applied = await this.repository.getMutation(
      mutation.workspaceId,
      mutation.projectId,
      mutation.mutationId
    )
    if (applied) {
      if (applied.inputDigest !== inputDigest) throw new ProjectStateError('MUTATION_ID_REUSED')
      const state = await this.repository.getAtRevision(
        mutation.workspaceId,
        mutation.projectId,
        applied.resultingRevision
      )
      if (!state) throw new ProjectStateError('REVISION_MISSING')
      return { state, applied: false }
    }

    for (;;) {
      const current = await this.repository.get(mutation.workspaceId, mutation.projectId)
      if (!current) throw new ProjectStateError('PROJECT_STATE_MISSING')
      if (isAfter(current.updatedAt, mutation.at)) {
        throw new ProjectStateError('TIMESTAMP_REGRESSION')
      }
      if (mutation.expectedRevision > current.revision) {
        throw new ProjectStateConflict(mutation.expectedRevision, current.revision, [])
      }
      if (mutation.expectedRevision < current.revision) {
        const base = await this.repository.getAtRevision(
          mutation.workspaceId,
          mutation.projectId,
          mutation.expectedRevision
        )
        const conflicts = base ? conflictingItemIds(base, current, mutation.operations) : []
        if (!base || conflicts.length > 0) {
          throw new ProjectStateConflict(mutation.expectedRevision, current.revision, conflicts)
        }
      }
      const next = applyOperations(current, mutation.operations, mutation.at)
      const record: AppliedStateMutation = {
        mutationId: mutation.mutationId,
        inputDigest,
        resultingRevision: next.revision,
        touchedItemIds: mutation.operations.map(operationItemId).toSorted(),
      }
      if (!(await this.repository.compareAndSet(current.revision, next, record))) {
        const winner = await this.repository.getMutation(
          mutation.workspaceId,
          mutation.projectId,
          mutation.mutationId
        )
        if (winner) {
          if (winner.inputDigest !== inputDigest) throw new ProjectStateError('MUTATION_ID_REUSED')
          const winnerState = await this.repository.getAtRevision(
            mutation.workspaceId,
            mutation.projectId,
            winner.resultingRevision
          )
          if (!winnerState) throw new ProjectStateError('REVISION_MISSING')
          return { state: winnerState, applied: false }
        }
        continue
      }
      await this.events.publish({
        type: 'project_state.changed',
        workspaceId: mutation.workspaceId,
        projectId: mutation.projectId,
        revision: next.revision,
        mutationId: mutation.mutationId,
        actorPrincipalRef: mutation.actorPrincipalRef,
        occurredAt: mutation.at,
      })
      return { state: next, applied: true }
    }
  }

  async getAtRevision(input: unknown): Promise<ProjectState> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        projectId: IdentifierSchemas.projectId,
        revision: z.number().int().nonnegative(),
      })
      .parse(input)
    const state = await this.repository.getAtRevision(
      parsed.workspaceId,
      parsed.projectId,
      parsed.revision
    )
    if (!state) throw new ProjectStateError('REVISION_MISSING')
    return state
  }

  async getHistory(input: unknown): Promise<readonly ProjectState[]> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        projectId: IdentifierSchemas.projectId,
      })
      .parse(input)
    return this.repository.getHistory(parsed.workspaceId, parsed.projectId)
  }

  async createPromotionProposal(input: unknown): Promise<StatePromotionProposal> {
    const parsed = PromotionProposalInputSchema.parse(input)
    if (
      parsed.operations.some((operation) => {
        const provenance = operationProvenance(operation)
        return (
          provenance.sourceKind !== 'execution' ||
          provenance.sourceExecutionId !== parsed.sourceExecutionId
        )
      })
    ) {
      throw new ProjectStateError('PROMOTION_REQUIRED')
    }
    if (
      !(await this.repository.getAtRevision(
        parsed.workspaceId,
        parsed.projectId,
        parsed.baseRevision
      ))
    ) {
      throw new ProjectStateError('REVISION_MISSING')
    }
    const proposal = StatePromotionProposalSchema.parse({
      ...parsed,
      revision: 1,
      state: 'candidate',
    })
    if (!(await this.proposals.insert(proposal))) throw new ProjectStateError('PROPOSAL_EXISTS')
    return proposal
  }

  async approvePromotion(input: unknown): Promise<StatePromotionProposal> {
    const parsed = reviewInput(input)
    const proposal = await this.#getProposal(parsed.proposalId)
    if (!isAfter(proposal.expiresAt, parsed.reviewedAt)) {
      throw new ProjectStateError('PROPOSAL_EXPIRED')
    }
    return this.#transitionProposal(parsed.proposalId, 'candidate', {
      state: 'approved',
      reviewedAt: parsed.reviewedAt,
      reviewingPrincipalRef: parsed.reviewingPrincipalRef,
    })
  }

  async rejectPromotion(input: unknown): Promise<StatePromotionProposal> {
    const parsed = reviewInput(input, true)
    return this.#transitionProposal(parsed.proposalId, 'candidate', {
      state: 'rejected',
      reviewedAt: parsed.reviewedAt,
      reviewingPrincipalRef: parsed.reviewingPrincipalRef,
      reviewReason: parsed.reason,
    })
  }

  async mergePromotion(input: unknown): Promise<StatePromotionProposal> {
    const parsed = z
      .object({
        proposalId: IdentifierSchemas.statePromotionProposalId,
        mutationId: IdentifierSchemas.stateMutationId,
        mergedAt: TimestampSchema,
      })
      .parse(input)
    const proposal = await this.#getProposal(parsed.proposalId)
    if (proposal.state !== 'approved') throw new ProjectStateError('PROPOSAL_STATE_CONFLICT')
    if (!isAfter(proposal.expiresAt, parsed.mergedAt)) {
      throw new ProjectStateError('PROPOSAL_EXPIRED')
    }
    const result = await this.#applyMutation(
      {
        mutationId: parsed.mutationId,
        workspaceId: proposal.workspaceId,
        projectId: proposal.projectId,
        expectedRevision: proposal.baseRevision,
        actorPrincipalRef: proposal.reviewingPrincipalRef,
        operations: proposal.operations,
        at: parsed.mergedAt,
      },
      true
    )
    return this.#replaceProposal(proposal, {
      state: 'merged',
      mergedAt: parsed.mergedAt,
      resultingProjectStateRevision: result.state.revision,
    })
  }

  async supersedePromotion(
    proposalId: string,
    supersededByProposalId: string,
    supersededAt: string
  ): Promise<StatePromotionProposal> {
    const successor = await this.#getProposal(supersededByProposalId)
    const current = await this.#getProposal(proposalId)
    if (
      !['candidate', 'approved'].includes(current.state) ||
      successor.workspaceId !== current.workspaceId ||
      successor.projectId !== current.projectId ||
      successor.state !== 'candidate'
    ) {
      throw new ProjectStateError('PROPOSAL_STATE_CONFLICT')
    }
    return this.#replaceProposal(current, {
      state: 'superseded',
      supersededAt: TimestampSchema.parse(supersededAt),
      supersededByProposalId: successor.proposalId,
    })
  }

  async expirePromotion(proposalId: string, expiredAt: string): Promise<StatePromotionProposal> {
    const proposal = await this.#getProposal(proposalId)
    const at = TimestampSchema.parse(expiredAt)
    if (!['candidate', 'approved'].includes(proposal.state)) {
      throw new ProjectStateError('PROPOSAL_STATE_CONFLICT')
    }
    if (isAfter(proposal.expiresAt, at)) throw new ProjectStateError('PROPOSAL_NOT_EXPIRED')
    return this.#replaceProposal(proposal, { state: 'expired', expiredAt: at })
  }

  async #transitionProposal(
    proposalId: string,
    expectedState: StatePromotionProposal['state'],
    patch: Partial<StatePromotionProposal>
  ): Promise<StatePromotionProposal> {
    const proposal = await this.#getProposal(proposalId)
    if (proposal.state !== expectedState) throw new ProjectStateError('PROPOSAL_STATE_CONFLICT')
    return this.#replaceProposal(proposal, patch)
  }

  async #replaceProposal(
    proposal: StatePromotionProposal,
    patch: Partial<StatePromotionProposal>
  ): Promise<StatePromotionProposal> {
    const next = StatePromotionProposalSchema.parse({
      ...proposal,
      ...patch,
      revision: proposal.revision + 1,
    })
    if (!(await this.proposals.compareAndSet(proposal.revision, next))) {
      throw new ProjectStateError('PROPOSAL_STATE_CONFLICT')
    }
    return next
  }

  async #getProposal(proposalId: string): Promise<StatePromotionProposal> {
    const parsedId = IdentifierSchemas.statePromotionProposalId.parse(proposalId)
    const proposal = await this.proposals.get(parsedId)
    if (!proposal) throw new ProjectStateError('PROPOSAL_MISSING')
    return proposal
  }
}

function applyOperations(
  current: ProjectState,
  operations: readonly ProjectStateOperation[],
  at: string
): ProjectState {
  const items = new Map(current.items.map((item) => [item.itemId, clone(item)]))
  for (const operation of operations) {
    if (operation.kind === 'append') {
      if (
        items.has(operation.item.itemId) ||
        [...items.values()].some((item) => item.key === operation.item.key)
      ) {
        throw new ProjectStateError('ITEM_ALREADY_EXISTS')
      }
      items.set(
        operation.item.itemId,
        ProjectStateItemSchema.parse({
          ...operation.item,
          itemRevision: 1,
          createdAt: at,
          updatedAt: at,
        })
      )
    } else {
      const previous = items.get(operation.itemId)
      if (!previous) throw new ProjectStateError('ITEM_MISSING')
      if (previous.itemRevision !== operation.expectedItemRevision) {
        throw new ProjectStateError('ITEM_REVISION_CONFLICT')
      }
      items.set(
        operation.itemId,
        ProjectStateItemSchema.parse({
          ...previous,
          ...operation,
          kind: undefined,
          expectedItemRevision: undefined,
          itemRevision: previous.itemRevision + 1,
          updatedAt: at,
        })
      )
    }
  }
  return ProjectStateSchema.parse({
    ...current,
    revision: current.revision + 1,
    items: [...items.values()].toSorted(
      (left, right) => left.key.localeCompare(right.key) || left.itemId.localeCompare(right.itemId)
    ),
    updatedAt: at,
  })
}

function conflictingItemIds(
  base: ProjectState,
  current: ProjectState,
  operations: readonly ProjectStateOperation[]
): string[] {
  const baseById = new Map(base.items.map((item) => [item.itemId, item]))
  const currentById = new Map(current.items.map((item) => [item.itemId, item]))
  const changedIds = new Set(
    current.items
      .filter((item) => canonical(item) !== canonical(baseById.get(item.itemId)))
      .map((item) => item.itemId)
  )
  const changedKeys = new Set(
    current.items
      .filter((item) => canonical(item) !== canonical(baseById.get(item.itemId)))
      .map((item) => item.key)
  )
  return operations
    .filter((operation) => {
      if (changedIds.has(operationItemId(operation))) return true
      if (operation.kind === 'append') return changedKeys.has(operation.item.key)
      const baseItem = baseById.get(operation.itemId)
      const currentItem = currentById.get(operation.itemId)
      return canonical(baseItem) !== canonical(currentItem)
    })
    .map(operationItemId)
    .toSorted()
}

function operationItemId(operation: ProjectStateOperation): ProjectStateItem['itemId'] {
  return operation.kind === 'append' ? operation.item.itemId : operation.itemId
}

function operationProvenance(operation: ProjectStateOperation) {
  return operation.kind === 'append' ? operation.item.provenance : operation.provenance
}

function reviewInput(input: unknown, requireReason = false) {
  return z
    .object({
      proposalId: IdentifierSchemas.statePromotionProposalId,
      reviewingPrincipalRef: PrincipalRefSchema,
      reviewedAt: TimestampSchema,
      reason: requireReason
        ? z.string().min(1).max(1_024)
        : z.string().min(1).max(1_024).optional(),
    })
    .parse(input)
}

function stateKey(workspaceId: string, projectId: string): string {
  return `${workspaceId}:${projectId}`
}

function mutationKey(workspaceId: string, projectId: string, mutationId: string): string {
  return `${stateKey(workspaceId, projectId)}:${mutationId}`
}

function isAfter(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right)
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function canonical(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)])
    )
  }
  return value
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}

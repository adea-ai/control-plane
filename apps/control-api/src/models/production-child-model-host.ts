import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import {
  createExecutionBoundModelSelectionService,
  createFileRecordedModelFundingAuthority,
  createModelFundingPreparationService,
  ExecutionModelSelectionBindingSchema,
  ModelSelectionError,
  RecordedModelFundingDecisionSchema,
  resolveModelSelectionFundingView,
  type ExecutionModelSelectionBinding,
  type ModelSelectionService,
  type RuntimeProviderSelection,
} from '@control-plane/model-gateway'
import {
  PiDurableAdmissionSchema,
  type DurableExecutionAuthority,
  type PiDurableAdmission,
} from '@control-plane/pi-durable-adapter'
import { RuntimeStartRequestSchema, type RuntimeStartRequest } from '@control-plane/runtime-sdk'
import type { ProductionChildRecord } from './production-child-current.js'
import {
  ProductionChildModelRequestSchema,
  resolveChildModelSelection,
} from './production-child-model-authority.js'
import type { AcceptedModelFundingExecutionAuthority } from './recorded-model-funding.js'
import type { createProductionLeadProductAuthority } from './production-lead-product.js'
import { createSqliteModelFundingConfirmations } from './sqlite-funding-confirmations.js'

function deny(): never {
  throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
}
const sameJson = (left: unknown, right: unknown) =>
  canonicalJsonStringify(left) === canonicalJsonStringify(right)

/**
 * The identity the native composition derives from a start request and its admission. Child
 * funding is prepared and read against this exact binding, so the two cannot diverge.
 */
export function childExecutionBinding(input: {
  readonly plan: ProductionChildRecord['plan']
  readonly workspaceId: string
  readonly executionId: string
  readonly attemptId: string
  readonly principalRef: string
  readonly canonicalActorPrincipalId: string
  readonly authorityRevision: number
  readonly selection: RuntimeProviderSelection
  readonly leasePrincipalRef: string
  readonly modelAlias: string
}): ExecutionModelSelectionBinding {
  return ExecutionModelSelectionBindingSchema.parse({
    schemaVersion: 'execution-model-selection/v1',
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    attemptId: input.attemptId,
    requestId: input.plan.correlation.requestId,
    executionPlanId: input.plan.executionPlanId,
    executionPlanDigest: input.plan.contentDigest,
    executionPlanSchemaVersion: input.plan.schemaVersion,
    policySnapshotDigest: input.plan.policySnapshot.digest,
    principalRef: input.principalRef,
    canonicalActorPrincipalId: input.canonicalActorPrincipalId,
    leasePrincipalRef: input.leasePrincipalRef,
    modelAlias: input.modelAlias,
    authorityRevision: input.authorityRevision,
    selectionRef: input.selection.selectionRef,
    selectionRevision: input.selection.selectionRevision,
  })
}

export interface ProductionChildModelHostOptions {
  /** Server-owned child lineage; callers supply identifiers only. */
  readonly current: {
    readRecord(input: { executionId: string; attemptId: string }): Promise<ProductionChildRecord>
  }
  readonly product: Pick<
    ReturnType<typeof createProductionLeadProductAuthority>,
    'resolveChildSelection'
  >
  readonly selections: Pick<
    ModelSelectionService,
    'resolveSelection' | 'assertReady' | 'withCredential'
  >
  readonly fundingDirectory: string
  readonly database: Parameters<typeof createSqliteModelFundingConfirmations>[0]
  readonly leasePrincipalRef: string
  readonly modelAlias: string
  readonly maximumRetainedFacades?: number
  readonly now?: () => string
}

/**
 * Child admission, funding and provider/spending binding, derived only from retained child
 * records and the server-resolved child selection. Recorded funding files remain operator-owned;
 * this host never creates a credential, grant, reservation or budget.
 */
export function createProductionChildModelHost(options: ProductionChildModelHostOptions) {
  const maximum = options.maximumRetainedFacades ?? 256
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
    throw new ModelSelectionError('READINESS_UNAVAILABLE')

  /** The one server-side derivation behind every child port. */
  async function derive(input: { executionId: string; attemptId: string }) {
    const record = await options.current.readRecord(input)
    const child = ProductionChildModelRequestSchema.parse(record.current)
    const selection = await resolveChildModelSelection(options.product, child)
    const binding = childExecutionBinding({
      plan: record.plan,
      workspaceId: child.workspaceId,
      executionId: child.executionId,
      attemptId: child.attemptId,
      principalRef: record.principalRef,
      canonicalActorPrincipalId: child.canonicalActorPrincipalId,
      authorityRevision: child.authorityRevision,
      selection,
      leasePrincipalRef: options.leasePrincipalRef,
      modelAlias: options.modelAlias,
    })
    return { binding, record, selection }
  }

  const executionAuthority: AcceptedModelFundingExecutionAuthority = {
    async resolveForReader(input) {
      const { binding, record } = await derive(input)
      if (!record.allowedPrincipalIds.includes(input.principalId)) deny()
      if (
        binding.workspaceId !== input.workspaceId ||
        binding.selectionRef !== input.selectionRef ||
        binding.selectionRevision !== input.selectionRevision
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      return binding
    },
    async assertCurrent(input) {
      const claimed = ExecutionModelSelectionBindingSchema.parse(input)
      const { binding } = await derive(claimed)
      if (!sameJson(binding, claimed)) throw new ModelSelectionError('SELECTION_CHANGED')
    },
  }

  const fundingAuthority = createFileRecordedModelFundingAuthority({
    directory: options.fundingDirectory,
    currentExecutionAuthority: executionAuthority,
    ...(options.now ? { now: options.now } : {}),
  })
  const confirmations = createSqliteModelFundingConfirmations(options.database)
  const readFunding = (binding: ExecutionModelSelectionBinding) =>
    resolveModelSelectionFundingView({
      binding,
      selections: createExecutionBoundModelSelectionService({
        binding,
        selections: options.selections,
        currentExecutionAuthority: executionAuthority,
      }),
      fundingAuthority,
      ...(options.now ? { now: options.now } : {}),
    })
  const preparation = createModelFundingPreparationService({
    executionAuthority,
    confirmations,
    readFunding,
    ...(options.now ? { now: options.now } : {}),
  })
  const confirmed = preparation.confirmedExecutionAuthority

  const facades = new Map<
    string,
    { pin: string; facade: ReturnType<typeof createExecutionBoundModelSelectionService> }
  >()
  const key = (binding: ExecutionModelSelectionBinding) =>
    `${binding.workspaceId}/${binding.executionId}/${binding.attemptId}`

  return {
    /** Called only after selection readiness; prepares the child attempt's funding confirmation. */
    async admit(
      request: RuntimeStartRequest,
      selection: RuntimeProviderSelection
    ): Promise<PiDurableAdmission> {
      const start = RuntimeStartRequestSchema.parse(request)
      const {
        binding,
        record,
        selection: resolved,
      } = await derive({
        executionId: start.executionId ?? deny(),
        attemptId: start.attemptId,
      })
      if (
        resolved.selectionRef !== selection.selectionRef ||
        resolved.selectionRevision !== selection.selectionRevision
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      const admission = PiDurableAdmissionSchema.parse({
        schemaVersion: 'pi-durable-admission/v1',
        prompt: record.objective,
        canonicalActorPrincipalId: record.current.canonicalActorPrincipalId,
        selection: {
          selectionRef: resolved.selectionRef,
          selectionRevision: resolved.selectionRevision,
        },
        authority: {
          revision: record.current.authorityRevision,
          principalRef: record.principalRef,
          scopeRef: record.scopeRef,
          expiresAt: record.current.expiresAt,
        },
      })
      await preparation.prepareFunding(binding, record.current.expiresAt)
      return admission
    },

    /** Re-derives the admitted identity from retained records and requires its funding confirmation. */
    async assertCurrent(authority: DurableExecutionAuthority) {
      const start = RuntimeStartRequestSchema.parse(authority.request)
      const admission = PiDurableAdmissionSchema.parse(authority.admission)
      const { binding } = await derive({
        executionId: start.executionId ?? deny(),
        attemptId: start.attemptId,
      })
      if (
        binding.selectionRef !== admission.selection.selectionRef ||
        binding.selectionRevision !== admission.selection.selectionRevision ||
        binding.authorityRevision !== admission.authority.revision ||
        binding.principalRef !== admission.authority.principalRef ||
        binding.canonicalActorPrincipalId !== admission.canonicalActorPrincipalId
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      await confirmed.assertCurrent(binding)
    },

    /** The recorded funding decision for this child attempt, read against its derived binding. */
    async readRecordedDecision(authority: DurableExecutionAuthority) {
      const start = RuntimeStartRequestSchema.parse(authority.request)
      const admission = PiDurableAdmissionSchema.parse(authority.admission)
      const executionId = start.executionId ?? deny()
      const { record } = await derive({ executionId, attemptId: start.attemptId })
      const binding = await executionAuthority.resolveForReader({
        workspaceId: record.current.workspaceId,
        executionId,
        attemptId: start.attemptId,
        principalId: record.current.productReaderPrincipalId,
        selectionRef: admission.selection.selectionRef,
        selectionRevision: admission.selection.selectionRevision,
      })
      if (!binding) deny()
      return RecordedModelFundingDecisionSchema.parse(await fundingAuthority.readCurrent(binding))
    },

    /** Native provider and spending resolution must use this one confirmed facade per attempt. */
    forExecution(input: unknown) {
      const binding = ExecutionModelSelectionBindingSchema.parse(input)
      const pin = canonicalJsonStringify(binding)
      const existing = facades.get(key(binding))
      if (existing) {
        if (existing.pin !== pin) throw new ModelSelectionError('SELECTION_CHANGED')
        return existing.facade
      }
      if (facades.size >= maximum) throw new ModelSelectionError('READINESS_UNAVAILABLE')
      const facade = createExecutionBoundModelSelectionService({
        binding,
        selections: options.selections,
        currentExecutionAuthority: confirmed,
      })
      facades.set(key(binding), { pin, facade })
      return facade
    },

    /** Only after canonical terminal/expiry cleanup; retains references, never leases or models. */
    forgetTerminalExecution(authority: DurableExecutionAuthority) {
      const start = RuntimeStartRequestSchema.parse(authority.request)
      const workspaceId = assertExecutionPlanIntegrity(start.executionPlan).correlation.workspaceId
      facades.delete(`${workspaceId}/${start.executionId ?? deny()}/${start.attemptId}`)
    },

    /** Proof surface: the server-derived binding, never a credential, grant or spend authority. */
    bindingFor: async (input: { executionId: string; attemptId: string }) =>
      (await derive(input)).binding,
  }
}

import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  createExecutionBoundModelSelectionService,
  ExecutionModelSelectionBindingSchema,
  type CurrentModelExecutionAuthority,
  type ExecutionModelSelectionBinding,
  type ModelSelectionService,
} from '@control-plane/model-gateway'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import {
  PiDurableAdmissionSchema,
  type DurableExecutionAuthority,
  type PiDurableRuntimeOptions,
} from './contracts.js'
import { createPiDurableProviderResolver } from './provider.js'
import {
  createPiRecordedSpendingAuthority,
  type PiRecordedSpendingAuthorityOptions,
} from './spending-authority.js'

export interface PiExecutionBoundModelCompositionOptions {
  readonly selections?: Pick<
    ModelSelectionService,
    'resolveSelection' | 'assertReady' | 'withCredential'
  >
  /** Mandatory host reader of canonical admission, current original actor/scope,
   * grant/audience and exact attempt. A caller-supplied snapshot is insufficient.
   */
  readonly currentExecutionAuthority?: CurrentModelExecutionAuthority
  /** Trusted host factory, compatible with createCanonicalModelHostComposition.
   * Its confirmed funding/current-authority facade is shared by native provider
   * and spending resolution; rejection never falls back to the default reader.
   */
  readonly forExecution?: (
    binding: ExecutionModelSelectionBinding
  ) => ReturnType<typeof createExecutionBoundModelSelectionService>
  readonly maximumRetainedFacades?: number
  readonly leasePrincipalRef: string
  readonly modelAlias: string
  readonly ledger: PiRecordedSpendingAuthorityOptions['ledger']
  readonly readRecordedDecision: PiRecordedSpendingAuthorityOptions['readRecordedDecision']
  readonly now?: () => string
}

/** Opt-in native composition for explicit canonical execution plans. Selection
 * readiness and recorded spending share the same exact execution binding and
 * mandatory live authority reader. Existing legacy provider ports stay separate.
 */
export function createPiExecutionBoundModelComposition(
  options: PiExecutionBoundModelCompositionOptions
) {
  if (options.forExecution !== undefined && typeof options.forExecution !== 'function')
    throw new Error('PI_EXECUTION_MODEL_AUTHORITY_REQUIRED')
  if (
    !options.forExecution &&
    (typeof options.currentExecutionAuthority?.assertCurrent !== 'function' ||
      typeof options.selections?.resolveSelection !== 'function' ||
      typeof options.selections?.assertReady !== 'function' ||
      typeof options.selections?.withCredential !== 'function')
  )
    throw new Error('PI_EXECUTION_MODEL_AUTHORITY_REQUIRED')
  const maximum = options.maximumRetainedFacades ?? 256
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
    throw new Error('PI_EXECUTION_MODEL_FACADE_LIMIT_INVALID')
  const facades = new Map<
    string,
    { pin: string; facade: ReturnType<typeof createExecutionBoundModelSelectionService> }
  >()

  function forExecution(authority: DurableExecutionAuthority) {
    const request = RuntimeStartRequestSchema.parse(authority.request)
    const admission = PiDurableAdmissionSchema.parse(authority.admission)
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    const budget = request.attemptBudget
    if (
      plan.schemaVersion !== 2 ||
      !admission.canonicalActorPrincipalId ||
      !budget ||
      budget.workspaceId !== plan.correlation.workspaceId ||
      budget.executionId !== request.executionId ||
      budget.attemptId !== request.attemptId ||
      budget.executionPlanId !== plan.executionPlanId ||
      budget.executionPlanDigest !== plan.contentDigest ||
      !plan.constraints.models.some((model) => model.alias === options.modelAlias)
    )
      throw new Error('PI_EXECUTION_MODEL_BINDING_REQUIRED')
    const binding = ExecutionModelSelectionBindingSchema.parse({
      schemaVersion: 'execution-model-selection/v1',
      workspaceId: budget.workspaceId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      requestId: plan.correlation.requestId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      executionPlanSchemaVersion: plan.schemaVersion,
      policySnapshotDigest: plan.policySnapshot.digest,
      principalRef: admission.authority.principalRef,
      canonicalActorPrincipalId: admission.canonicalActorPrincipalId,
      leasePrincipalRef: options.leasePrincipalRef,
      modelAlias: options.modelAlias,
      authorityRevision: admission.authority.revision,
      ...admission.selection,
    })
    return binding
  }

  function selectionService(authority: DurableExecutionAuthority) {
    const binding = forExecution(authority)
    const key = `${binding.workspaceId}/${binding.executionId}/${binding.attemptId}`
    const pin = canonicalJsonStringify(binding)
    const existing = facades.get(key)
    if (existing) {
      if (existing.pin !== pin) throw new Error('PI_EXECUTION_MODEL_BINDING_CHANGED')
      existing.facade.assertBinding(binding)
      return existing.facade
    }
    if (facades.size >= maximum) throw new Error('PI_EXECUTION_MODEL_FACADE_LIMIT_EXCEEDED')
    const facade = options.forExecution
      ? options.forExecution(structuredClone(binding))
      : createExecutionBoundModelSelectionService({
          selections: options.selections!,
          binding,
          currentExecutionAuthority: options.currentExecutionAuthority!,
        })
    if (
      typeof facade?.assertBinding !== 'function' ||
      typeof facade.resolveSelection !== 'function' ||
      typeof facade.assertReady !== 'function' ||
      typeof facade.withCredential !== 'function'
    )
      throw new Error('PI_EXECUTION_MODEL_FACADE_INVALID')
    facade.assertBinding(binding)
    facades.set(key, { pin, facade })
    return facade
  }

  const resolveProvider: PiDurableRuntimeOptions['resolveProvider'] = async (
    reference,
    authority
  ) =>
    createPiDurableProviderResolver({
      selectionService: selectionService(authority),
      leasePrincipalRef: options.leasePrincipalRef,
    })(reference, authority)

  const spending = createPiRecordedSpendingAuthority({
    ledger: options.ledger,
    alias: options.modelAlias,
    readRecordedDecision: options.readRecordedDecision,
    resolveSelection: async (authority) => {
      const service = selectionService(authority)
      const workspaceId = assertExecutionPlanIntegrity(authority.request.executionPlan).correlation
        .workspaceId
      return service.resolveSelection({ ...authority.admission.selection, workspaceId })
    },
    ...(options.now ? { now: options.now } : {}),
  })

  return {
    resolveProvider,
    ...spending,
    /** Host-only cleanup after canonical terminal/expiry retention. This drops
     * reference-only facades; the external host owns its corresponding cleanup.
     */
    forgetTerminalExecution(authority: DurableExecutionAuthority) {
      const binding = forExecution(authority)
      const key = `${binding.workspaceId}/${binding.executionId}/${binding.attemptId}`
      const retained = facades.get(key)
      if (retained && retained.pin !== canonicalJsonStringify(binding))
        throw new Error('PI_EXECUTION_MODEL_BINDING_CHANGED')
      facades.delete(key)
    },
  }
}

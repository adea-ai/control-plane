import { z } from 'zod'
import { ServicePrincipalSchema, executionScopeOf } from '@control-plane/contracts'
import {
  PiLeadHostSourceAuthoritySchema,
  PiLeadSourceExecutionBindingSchema,
  type PiLeadHostSourceAuthority,
} from './source-authority-contract.js'
import { assertExecutionPlanIntegrity, type ExecutionPlan } from '@control-plane/execution-plan'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import {
  PiDurableAdmissionSchema,
  type DurableExecutionAuthority,
} from '@control-plane/pi-durable-adapter'
import type { createProductionSourceLeadProductAuthority } from '../models/production-source-lead-product.js'
import {
  createNodePiDurableLeadComposition,
  type NodePiDurableLeadCompositionOptions,
} from './node-composition.js'

type SourceProduct = ReturnType<typeof createProductionSourceLeadProductAuthority>
type SourceRecord = NonNullable<ReturnType<SourceProduct['readRetained']>>
type PlanSource = Pick<SourceRecord, 'authority' | 'profileVersionId' | 'profileContentDigest'>

/** Metadata comparison only; the canonical plan validator and current source
 * principal/grant/model/tool/payer authority remain independently required.
 */
export function assertSourceLeadExecutionPlan(input: unknown, retained: PlanSource): ExecutionPlan {
  const plan = assertExecutionPlanIntegrity(input)
  const authority = PiLeadHostSourceAuthoritySchema.parse(retained.authority)
  if (
    plan.schemaVersion !== 2 ||
    executionScopeOf(plan.correlation).kind !== 'workspace' ||
    plan.parentExecutionPlan !== undefined ||
    plan.correlation.workspaceId !== authority.source.workspaceId ||
    plan.correlation.agentId !== authority.source.agentId ||
    plan.profile.profileVersionId !== retained.profileVersionId ||
    plan.profile.contentDigest !== retained.profileContentDigest
  )
    throw new Error('PI_LEAD_SOURCE_PLAN_CHANGED')
  return plan
}

/** Candidate bounded source composition: uses the existing Node admission,
 * preparation, journal, usage and Pi-native engine. No startup wiring, extra
 * lifecycle engine, credentials, grants, payer or model defaults are created.
 */
export async function createProductionSourceNodeComposition(
  options: Omit<NodePiDurableLeadCompositionOptions, 'admission'> & {
    admission: Omit<NodePiDurableLeadCompositionOptions['admission'], 'product'>
    sourceProduct: SourceProduct
    /** Existing source-authorized transport principal; never the original human. */
    transportPrincipalId: string
    /** Verify the compiled context contains only currently authorized host input,
     * post-join history and explicit shared resources, never source private history.
     */
    assertHostContext(plan: ExecutionPlan, authority: PiLeadHostSourceAuthority): Promise<void>
  }
) {
  ServicePrincipalSchema.shape.principalId.parse(options.transportPrincipalId)
  if (
    typeof options.sourceProduct?.readCurrent !== 'function' ||
    typeof options.sourceProduct?.readRetained !== 'function' ||
    typeof options.assertHostContext !== 'function'
  )
    throw new Error('PI_LEAD_SOURCE_COMPOSITION_REQUIRED')
  if (options.childAuthority || options.governedDelegateChild || options.childProgress)
    throw new Error('PI_LEAD_SOURCE_CHILD_UNQUALIFIED')
  const retainedFor = (workspaceId: string, intentId: string) => {
    const retained = options.sourceProduct.readRetained({ workspaceId, intentId })
    if (
      !retained ||
      retained.authority.source.workspaceId !== workspaceId ||
      retained.authority.intentId !== intentId
    )
      throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
    return retained
  }
  let adapter:
    | Parameters<NonNullable<NodePiDurableLeadCompositionOptions['onAdapterReady']>>[0]
    | undefined
  const assertCurrentRuntime = async (runtime: DurableExecutionAuthority) => {
    const request = RuntimeStartRequestSchema.parse(runtime.request)
    if (!request.idempotencyKey.startsWith('lead-turn:'))
      throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
    const intentId = z.uuid().parse(request.idempotencyKey.replace(/^lead-turn:/, ''))
    const compiled = assertExecutionPlanIntegrity(request.executionPlan)
    const source = retainedFor(compiled.correlation.workspaceId, intentId)
    const plan = assertSourceLeadExecutionPlan(compiled, source)
    const current = await options.sourceProduct.readCurrent({
      schemaVersion: 'pi-lead-intent/v1',
      workspaceId: source.authority.source.workspaceId,
      intentId,
      principalId: options.transportPrincipalId,
    })
    if (
      !current ||
      current.scopeRef !== source.scopeRef ||
      runtime.admission.authority.scopeRef !== source.scopeRef ||
      runtime.admission.selection.selectionRef !== source.selectionRef ||
      runtime.admission.selection.selectionRevision !== source.selectionRevision
    )
      throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
    await options.assertHostContext(plan, source.authority)
  }
  const composition = await createNodePiDurableLeadComposition({
    ...options,
    async onAdapterReady(ready) {
      adapter = ready
      await options.onAdapterReady?.(ready)
    },
    ...(options.tools
      ? {
          tools: {
            service: options.tools.service,
            async assertAuthority(request, boundary) {
              if (!adapter) throw new Error('PI_LEAD_SOURCE_RUNTIME_REQUIRED')
              // Resolve the exact retained attempt, never a caller-provided or
              // inferred latest native session. Existing owner/fence checks follow.
              const record = adapter.journal
                .list()
                .find((candidate) => candidate.attemptId === request.attemptId)
              if (!record) throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
              const stored = z
                .object({ request: RuntimeStartRequestSchema, admission: PiDurableAdmissionSchema })
                .parse(record.admission)
              const plan = assertExecutionPlanIntegrity(stored.request.executionPlan)
              if (
                request.executionId !== stored.request.executionId ||
                request.workspaceId !== plan.correlation.workspaceId ||
                request.profileId !== plan.profile.profileId ||
                request.grant.workspaceId !== request.workspaceId
              )
                throw new Error('PI_LEAD_SOURCE_TOOL_SCOPE_CHANGED')
              await assertCurrentRuntime(stored)
              await options.tools!.assertAuthority(request, boundary)
            },
          },
        }
      : {}),
    admission: {
      ...options.admission,
      product: options.sourceProduct,
      async resolvePlan(evidence, ids) {
        const source = retainedFor(evidence.workspaceId, evidence.intentId)
        if (evidence.scopeRef !== source.scopeRef) throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
        const plan = assertSourceLeadExecutionPlan(
          await options.admission.resolvePlan(evidence, ids),
          source
        )
        await options.assertHostContext(plan, source.authority)
        return plan
      },
    },
    async provider(reference, authority) {
      await assertCurrentRuntime(authority)
      const access = await options.provider(reference, authority)
      if (
        access.workspaceId !==
          assertExecutionPlanIntegrity(authority.request.executionPlan).correlation.workspaceId ||
        access.selectionRef !== reference.selectionRef ||
        access.selectionRevision !== reference.selectionRevision
      )
        throw new Error('PI_LEAD_SOURCE_PROVIDER_CHANGED')
      return access
    },
  })
  return Object.assign(composition, {
    /** Publication-safe retained metadata read: no product callback, credential
     * lease, reservation, runtime start or inferred latest attempt. Current CP
     * publication authority and Adea's locked host audience still gate delivery.
     */
    async readRetainedSourceExecutionBinding(intentId: string) {
      z.uuid().parse(intentId)
      const marker = composition.admission.store.marker(intentId)
      if (!marker || marker.state !== 'ready') return undefined
      const source = retainedFor(marker.workspaceId, intentId)
      if (
        source.scopeRef !== marker.intent.scopeRef ||
        source.selectionRef !== marker.intent.selectionRef ||
        source.selectionRevision !== marker.intent.selectionRevision
      )
        throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
      const plan = assertSourceLeadExecutionPlan(
        await options.admission.plans.get(marker.planPin),
        source
      )
      const request = RuntimeStartRequestSchema.parse({
        executionId: marker.intent.executionId,
        attemptId: marker.intent.attemptId,
        idempotencyKey: `lead-turn:${intentId}`,
        executionPlan: plan,
        attemptBudget: composition.admission.store.budget(intentId),
      })
      const handle = await composition.adapter.findExistingHandle(request)
      if (!handle?.externalSessionId) return undefined
      return PiLeadSourceExecutionBindingSchema.parse({
        schemaVersion: 'pi-lead-source-execution-binding/v1',
        authority: source.authority,
        intentExpiresAt: source.expiresAt,
        profileVersionId: source.profileVersionId,
        profileContentDigest: source.profileContentDigest,
        selectionRef: source.selectionRef,
        selectionRevision: source.selectionRevision,
        executionId: marker.intent.executionId,
        attemptId: marker.intent.attemptId,
        runtimeSessionId: handle.externalSessionId,
      })
    },
  })
}

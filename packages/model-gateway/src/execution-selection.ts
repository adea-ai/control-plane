import { z } from 'zod'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { RuntimeProviderSelectionSchema, type RuntimeProviderSelection } from './selection.js'
import { ModelSelectionError, type ModelSelectionService } from './selection-service.js'
import type { ModelHttpAuthority } from './litellm-http.js'

const Ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
/** Host-only canonical admission pin. This schema authenticates no client claim. */
export const ExecutionModelSelectionBindingSchema = z.strictObject({
  schemaVersion: z.literal('execution-model-selection/v1'),
  workspaceId: IdentifierSchemas.workspaceId,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  requestId: IdentifierSchemas.requestId,
  executionPlanId: IdentifierSchemas.executionPlanId,
  executionPlanDigest: Digest,
  executionPlanSchemaVersion: z.number().int().positive(),
  policySnapshotDigest: Digest,
  principalRef: Ref,
  modelAlias: Ref,
  canonicalActorPrincipalId: Ref,
  leasePrincipalRef: Ref,
  authorityRevision: z.number().int().positive(),
  selectionRef: RuntimeProviderSelectionSchema.shape.selectionRef,
  selectionRevision: RuntimeProviderSelectionSchema.shape.selectionRevision,
})
export type ExecutionModelSelectionBinding = z.output<typeof ExecutionModelSelectionBindingSchema>
export interface CurrentModelExecutionAuthority {
  /** Resolve the server-owned accepted intent/plan and recheck current kernel scope,
   * caller/audience/grant/expiry. Must reject changed bindings; never a truthy client claim.
   * Funding/physical-dispatch authorization remains a separate existing authority.
   */
  assertCurrent(binding: ExecutionModelSelectionBinding): Promise<void>
}

/** A per-execution facade for R1 provider and recorded-spending resolvers. Every
 * inference/reopen/send resolves current authority; no lease or Models registry is retained.
 */
export function createExecutionBoundModelSelectionService(options: {
  selections: Pick<ModelSelectionService, 'resolveSelection' | 'assertReady' | 'withCredential'>
  binding: unknown
  currentExecutionAuthority: CurrentModelExecutionAuthority
}) {
  const binding = ExecutionModelSelectionBindingSchema.parse(options.binding)
  if (typeof options.currentExecutionAuthority?.assertCurrent !== 'function')
    throw new ModelSelectionError('READINESS_UNAVAILABLE')
  async function current() {
    try {
      await options.currentExecutionAuthority.assertCurrent(structuredClone(binding))
    } catch {
      throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
    }
  }
  async function assertReady(selection: RuntimeProviderSelection) {
    const parsed = RuntimeProviderSelectionSchema.safeParse(selection)
    if (
      !parsed.success ||
      selection.workspaceId !== binding.workspaceId ||
      selection.selectionRef !== binding.selectionRef ||
      selection.selectionRevision !== binding.selectionRevision
    )
      throw new ModelSelectionError('SELECTION_CHANGED')
    await current()
    await options.selections.assertReady(selection)
  }
  return {
    assertBinding(input: unknown) {
      const parsed = ExecutionModelSelectionBindingSchema.safeParse(input)
      if (
        !parsed.success ||
        canonicalJsonStringify(parsed.data) !== canonicalJsonStringify(binding)
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
    },
    async resolveSelection(input: Parameters<ModelSelectionService['resolveSelection']>[0]) {
      const parsed = z
        .strictObject({
          workspaceId: IdentifierSchemas.workspaceId,
          selectionRef: RuntimeProviderSelectionSchema.shape.selectionRef,
          selectionRevision: RuntimeProviderSelectionSchema.shape.selectionRevision,
        })
        .safeParse(input)
      if (
        !parsed.success ||
        parsed.data.workspaceId !== binding.workspaceId ||
        parsed.data.selectionRef !== binding.selectionRef ||
        parsed.data.selectionRevision !== binding.selectionRevision
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      await current()
      const selection = await options.selections.resolveSelection(parsed.data)
      await assertReady(selection)
      return selection
    },
    assertReady,
    async withCredential<Result>(
      selection: RuntimeProviderSelection,
      authority: Parameters<ModelSelectionService['withCredential']>[1],
      operation: (secret: string) => Result | Promise<Result>
    ): Promise<Result> {
      if (
        authority.requestId !== binding.requestId ||
        authority.principalRef !== binding.leasePrincipalRef ||
        authority.policySnapshot.digest !== binding.policySnapshotDigest
      )
        throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      await assertReady(selection)
      return options.selections.withCredential(selection, authority, async (secret) => {
        await assertReady(selection)
        return operation(secret)
      })
    },
  }
}

/** Adds selected execution/eligibility checks to the existing HTTP spending authority.
 * The delegate and LedgerLiteLlmHttpClient retain grant/price/physical-send ownership.
 */
export function createExecutionBoundModelHttpAuthority(options: {
  authority: ModelHttpAuthority
  selections: ReturnType<typeof createExecutionBoundModelSelectionService>
  binding: unknown
}): ModelHttpAuthority {
  const binding = ExecutionModelSelectionBindingSchema.parse(options.binding)
  options.selections.assertBinding(binding)
  return {
    async authorize(context, signal) {
      const { request } = context
      if (
        !request.selection ||
        request.workspaceId !== binding.workspaceId ||
        request.executionId !== binding.executionId ||
        request.attemptId !== binding.attemptId ||
        request.requestId !== binding.requestId ||
        request.principalRef !== binding.principalRef ||
        request.alias !== binding.modelAlias ||
        request.policySnapshot.digest !== binding.policySnapshotDigest
      )
        throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      const pinned = canonicalJsonStringify(request.selection)
      const check = async () => {
        signal.throwIfAborted()
        const current = await options.selections.resolveSelection({
          workspaceId: binding.workspaceId,
          selectionRef: binding.selectionRef,
          selectionRevision: binding.selectionRevision,
        })
        if (canonicalJsonStringify(current) !== pinned)
          throw new ModelSelectionError('SELECTION_CHANGED')
        signal.throwIfAborted()
      }
      await check()
      const approved = await options.authority.authorize(context, signal)
      let closing: Promise<void> | undefined
      const closeOnce = () =>
        (closing ??= Promise.resolve()
          .then(() => approved.credential.close())
          .catch(() => {
            // Preserve bounded denial/abort; never expose credential cleanup details.
          }))
      let onAbort: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void closeOnce()
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      try {
        await Promise.race([check(), aborted])
        signal.throwIfAborted()
      } catch (error) {
        await closeOnce()
        throw error
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      return {
        ...approved,
        async assertActive(activeSignal) {
          activeSignal.throwIfAborted()
          await approved.assertActive(activeSignal)
          await check()
          activeSignal.throwIfAborted()
        },
      }
    },
  }
}

import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  PiLeadHostSourceAuthoritySchema,
  RequestedRoleModelSelectionsSchema,
  IdentifierSchemas,
  ModelSelectionRefSchema,
  type PiLeadHostSourceAuthority,
} from '@control-plane/contracts'
import { createProductionLeadProductAuthority } from './production-lead-product.js'
import type { PiLeadProductAuthorityPort } from '../pi-durable/node-admission.js'

const Snapshot = z.strictObject({
  authority: PiLeadHostSourceAuthoritySchema,
  prompt: z
    .string()
    .min(1)
    .max(1_000_000)
    .refine((value) => value.trim().length > 0),
  expiresAt: z.iso.datetime(),
  requestedModelSelections: RequestedRoleModelSelectionsSchema.optional(),
})
const Retained = z.strictObject({
  authority: PiLeadHostSourceAuthoritySchema,
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  profileVersionId: IdentifierSchemas.profileVersionId,
  profileContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  selectionRef: ModelSelectionRefSchema,
  selectionRevision: z.number().int().positive(),
})
type Input = Parameters<PiLeadProductAuthorityPort['readCurrent']>[0]
type ProductOptions = Parameters<typeof createProductionLeadProductAuthority>[0]
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`

/** Candidate composition only; startup and Adea's foreign-Agent guard stay unchanged.
 * Host product/service authority and source execution authority are independent
 * required ports. The existing production model authority runs entirely in source
 * scope. A durable metadata binding ties that source execution to its host turn;
 * it is not a second conversation, execution or job state engine.
 */
export function createProductionSourceLeadProductAuthority(
  options: Omit<ProductOptions, 'product'> & {
    product: { readCurrent(input: Input): Promise<unknown | undefined> }
    assertHostService(input: {
      workspaceId: string
      principalId: string
      authority: PiLeadHostSourceAuthority
    }): Promise<void>
    assertSourceAuthority(input: {
      workspaceId: string
      principalId: string
      canonicalActorPrincipalId: string
      authority: PiLeadHostSourceAuthority
    }): Promise<void>
    /** Must hold current canonical host service and source actor/principal/grant
     * authority together while invoking this synchronous acceptance callback.
     * Sequential remote assertions are not an implementation of this fence.
     */
    withCurrentAuthorization<T>(
      input: {
        principalId: string
        authority: PiLeadHostSourceAuthority
      },
      accept: () => T
    ): Promise<T>
  }
) {
  if (
    typeof options.product?.readCurrent !== 'function' ||
    typeof options.assertHostService !== 'function' ||
    typeof options.assertSourceAuthority !== 'function' ||
    typeof options.withCurrentAuthorization !== 'function'
  )
    throw new Error('PI_LEAD_SOURCE_AUTHORITY_REQUIRED')
  options.database.exec(
    'CREATE TABLE IF NOT EXISTS pi_source_lead_product_bindings (workspace_id TEXT NOT NULL, intent_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(workspace_id,intent_id))'
  )
  const now = options.now ?? (() => new Date().toISOString())
  const readSnapshot = async (input: Input) => {
    const raw = await options.product.readCurrent(structuredClone(input))
    if (raw === undefined) return undefined
    const snapshot = Snapshot.parse(raw)
    const { authority } = snapshot
    if (
      authority.intentId !== input.intentId ||
      authority.source.workspaceId !== input.workspaceId ||
      Date.parse(snapshot.expiresAt) <= Date.parse(now())
    )
      throw new Error('PI_LEAD_SOURCE_PRODUCT_DENIED')
    await options.assertHostService({
      workspaceId: authority.host.workspaceId,
      principalId: input.principalId,
      authority: structuredClone(authority),
    })
    await options.assertSourceAuthority({
      workspaceId: authority.source.workspaceId,
      principalId: input.principalId,
      canonicalActorPrincipalId: authority.host.canonicalActorPrincipalId,
      authority: structuredClone(authority),
    })
    // Source authorization can await after the first host check. Revalidate
    // host standing and the original absolute deadline after those waits.
    // Final acceptance below additionally requires the combined canonical fence.
    await options.assertHostService({
      workspaceId: authority.host.workspaceId,
      principalId: input.principalId,
      authority: structuredClone(authority),
    })
    if (Date.parse(snapshot.expiresAt) <= Date.parse(now()))
      throw new Error('PI_LEAD_SOURCE_PRODUCT_DENIED')
    return snapshot
  }
  const readRetained = (input: Pick<Input, 'workspaceId' | 'intentId'>) => {
    const row = options.database
      .prepare(
        'SELECT record FROM pi_source_lead_product_bindings WHERE workspace_id=? AND intent_id=?'
      )
      .get(input.workspaceId, input.intentId)
    return row ? Retained.parse(JSON.parse(String(row['record']))) : undefined
  }
  const product = createProductionLeadProductAuthority({
    ...options,
    product: {
      async readCurrent(input) {
        const snapshot = await readSnapshot(input)
        if (!snapshot) return undefined
        const { authority, prompt, expiresAt, requestedModelSelections } = snapshot
        const actor = authority.host.canonicalActorPrincipalId
        return {
          schemaVersion: 'pi-lead-intent/v1',
          workspaceId: authority.source.workspaceId,
          intentId: authority.intentId,
          projectId: null,
          messageRef: `message:${authority.host.messageId}`,
          authorityRevision: authority.host.conversationVersion,
          principalRef: actor,
          canonicalActorPrincipalId: actor,
          scopeRef: `adea-source:${digest(snapshot)}`,
          expiresAt,
          allowedPrincipalIds: [input.principalId],
          prompt,
          profileId: authority.source.profileId,
          profileVersion: authority.source.profileVersion,
          profileRevision: authority.source.profileRevision,
          ...(requestedModelSelections ? { requestedModelSelections } : {}),
        }
      },
    },
  })
  return {
    /** Metadata lookup for trusted lifecycle adapters only; never an authorization decision. */
    readRetained,
    async readCurrent(input: Input) {
      const first = await readSnapshot(input)
      if (!first) return undefined
      const verified = await product.readCurrent(input)
      if (!verified || !('prompt' in verified)) throw new Error('PI_LEAD_SOURCE_PRODUCT_DENIED')
      const current = await readSnapshot(input)
      if (
        !current ||
        digest(first) !== digest(current) ||
        verified.scopeRef !== `adea-source:${digest(current)}`
      )
        throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
      return options.withCurrentAuthorization(
        {
          principalId: input.principalId,
          authority: structuredClone(current.authority),
        },
        () => {
          // No await separates this deadline check, fenced acceptance and return.
          // Expiry is supplied by the canonical intent; this read never renews it.
          if (Date.parse(current.expiresAt) <= Date.parse(now()))
            throw new Error('PI_LEAD_SOURCE_PRODUCT_DENIED')
          const proposed = Retained.parse({
            authority: current.authority,
            evidenceDigest: digest(verified),
            profileVersionId: verified.profileVersionId,
            profileContentDigest: verified.profileContentDigest,
            selectionRef: verified.selectionRef,
            selectionRevision: verified.selectionRevision,
          })
          options.database
            .prepare('INSERT OR IGNORE INTO pi_source_lead_product_bindings VALUES (?,?,?)')
            .run(input.workspaceId, input.intentId, canonicalJsonStringify(proposed))
          const retained = readRetained(input)
          if (!retained || digest(retained) !== digest(proposed))
            throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
          return verified
        }
      )
    },
  }
}

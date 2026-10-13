import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonStringify } from './canonical-json.js'
import { IdentifierSchemas } from './identifiers.js'
import { ModelSelectionRefSchema } from './model-connections.js'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ProductId = z.uuid().regex(/^[a-f0-9-]+$/)
const Ref = z.string().min(1).max(256)
const Revision = z.number().int().positive()
const Host = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  productWorkspaceId: ProductId,
  conversationId: ProductId,
  conversationVersion: Revision,
  messageId: ProductId,
  messageVersion: Revision,
  canonicalActorPrincipalId: z
    .string()
    .regex(/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  audienceDigest: Digest,
  enlistmentGrantId: Ref,
  enlistmentRevision: Revision,
})
const Source = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  productWorkspaceId: ProductId,
  agentId: IdentifierSchemas.agentId,
  productAgentId: ProductId,
  profileId: Ref,
  profileVersion: Ref,
  profileRevision: z.number().int().nonnegative(),
})

/** Stable native-context identity, distinct from a turn's immutable authority pins.
 * No source or pre-join native history is authorized by this reference.
 */
export function piLeadConversationAgentContextRef(input: {
  host: Pick<z.input<typeof Host>, 'workspaceId' | 'productWorkspaceId' | 'conversationId'>
  source: Pick<
    z.input<typeof Source>,
    'workspaceId' | 'productWorkspaceId' | 'agentId' | 'productAgentId'
  >
}): string {
  const identity = {
    host: Host.pick({ workspaceId: true, productWorkspaceId: true, conversationId: true }).parse({
      workspaceId: input.host.workspaceId,
      productWorkspaceId: input.host.productWorkspaceId,
      conversationId: input.host.conversationId,
    }),
    source: Source.pick({
      workspaceId: true,
      productWorkspaceId: true,
      agentId: true,
      productAgentId: true,
    }).parse({
      workspaceId: input.source.workspaceId,
      productWorkspaceId: input.source.productWorkspaceId,
      agentId: input.source.agentId,
      productAgentId: input.source.productAgentId,
    }),
  }
  return `sha256:${createHash('sha256')
    .update(
      canonicalJsonStringify({ schemaVersion: 'pi-conversation-agent-context/v1', ...identity })
    )
    .digest('hex')}`
}

/** Canonical private metadata only. Parsing never proves service, runtime,
 * source grant, model, tool or payer authorization. This additive contract is
 * not accepted by the existing single-workspace lead evidence endpoint.
 */
export const PiLeadHostSourceAuthoritySchema = z
  .strictObject({
    schemaVersion: z.literal('pi-lead-host-source-authority/v1'),
    intentId: ProductId,
    host: Host,
    source: Source,
    contextRef: Digest,
  })
  .superRefine((authority, context) => {
    if (
      authority.host.workspaceId === authority.source.workspaceId ||
      authority.host.productWorkspaceId === authority.source.productWorkspaceId ||
      authority.contextRef !== piLeadConversationAgentContextRef(authority)
    )
      context.addIssue({ code: 'custom', message: 'Foreign source/context binding required' })
  })

/** Pins produced by independently authorized source execution. Lifecycle
 * adapters must retain these exact pins; this record cannot mint authority.
 */
export const PiLeadSourceExecutionBindingSchema = z.strictObject({
  schemaVersion: z.literal('pi-lead-source-execution-binding/v1'),
  authority: PiLeadHostSourceAuthoritySchema,
  /** Fixed canonical intent deadline; reading or publishing never renews it. */
  intentExpiresAt: z.iso.datetime(),
  profileVersionId: IdentifierSchemas.profileVersionId,
  profileContentDigest: Digest,
  selectionRef: ModelSelectionRefSchema,
  selectionRevision: Revision,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  runtimeSessionId: IdentifierSchemas.externalSessionId,
})
export type PiLeadHostSourceAuthority = z.output<typeof PiLeadHostSourceAuthoritySchema>
export type PiLeadSourceExecutionBinding = z.output<typeof PiLeadSourceExecutionBindingSchema>

/** Compare fresh canonical host/source metadata with the retained intent.
 * Current host and source authorization must also be checked by their owners.
 */
export function assertPiLeadSourceExecutionBindingCurrent(
  retained: unknown,
  current: unknown
): PiLeadSourceExecutionBinding {
  const binding = PiLeadSourceExecutionBindingSchema.safeParse(retained)
  const authority = PiLeadHostSourceAuthoritySchema.safeParse(current)
  if (
    !binding.success ||
    !authority.success ||
    canonicalJsonStringify(binding.data.authority) !== canonicalJsonStringify(authority.data)
  )
    throw new Error('PI_LEAD_SOURCE_BINDING_CHANGED')
  return binding.data
}

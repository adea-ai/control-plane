import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import {
  ProviderBindingSchema,
  type DurableExecutionAuthority,
  type PiDurableProviderAccess,
  type ProviderSelectionReference,
} from './contracts.js'

/** Structural integration port for the gateway-owned immutable selection schema.
 * The complete snapshot stays in the gateway and is checked there, including
 * signed qualification, account, credential revision and workspace grant.
 */
export interface PiGatewaySelection {
  readonly selectionRef: string
  readonly selectionRevision: number
  readonly workspaceId: string
  readonly provider: string
  readonly providerModel: string
  readonly location: string
  readonly harness: string
  readonly harnessVersion: string
  readonly providerBinding: string
  readonly authKind: string
  readonly fundingSource: string
}

export function createPiDurableProviderResolver<Selection extends PiGatewaySelection>(options: {
  readonly selectionService: {
    resolveSelection(input: {
      selectionRef: string
      selectionRevision: number
      workspaceId: string
    }): Promise<Selection>
    assertReady(selection: Selection): Promise<void>
    withCredential<Result>(
      selection: Selection,
      authority: {
        requestId: string
        principalRef: string
        policySnapshot: ReturnType<
          typeof assertExecutionPlanIntegrity
        >['constraints']['policySnapshot']
      },
      operation: (secret: string) => Result | Promise<Result>
    ): Promise<Result>
  }
  /** Server-owned vault principal; no caller may supply lease authority. */
  readonly leasePrincipalRef: string
}) {
  return async (
    reference: ProviderSelectionReference,
    authority: DurableExecutionAuthority
  ): Promise<PiDurableProviderAccess> => {
    const workspaceId = authority.request.attemptBudget?.workspaceId
    if (!workspaceId) throw new Error('PI_ATTEMPT_AUTHORITY_REQUIRED')
    const plan = assertExecutionPlanIntegrity(authority.request.executionPlan)
    const selection = await options.selectionService.resolveSelection({ ...reference, workspaceId })
    await options.selectionService.assertReady(selection)
    const binding = ProviderBindingSchema.parse({
      selectionRef: selection.selectionRef,
      selectionRevision: selection.selectionRevision,
      workspaceId: selection.workspaceId,
      provider: selection.provider,
      providerModel: selection.providerModel,
      location: selection.location,
      harness: selection.harness,
      harnessVersion: selection.harnessVersion,
      providerBinding: selection.providerBinding,
    })
    if (
      binding.selectionRef !== reference.selectionRef ||
      binding.selectionRevision !== reference.selectionRevision ||
      binding.workspaceId !== workspaceId
    )
      throw new Error('PI_PROVIDER_SCOPE_MISMATCH')
    // This first concrete binding has one API and one account mode. Subscription
    // or another provider requires its own qualified binding, never fallback.
    if (selection.authKind !== 'api_key' || binding.provider !== 'openai')
      throw new Error('PI_PROVIDER_BINDING_UNSUPPORTED')
    const selected = openaiProvider()
      .getModels()
      .find((model) => model.id === binding.providerModel)
    if (!selected || selected.api !== 'openai-responses' || selected.provider !== binding.provider)
      throw new Error('PI_MODEL_UNAVAILABLE')
    const pinned = canonicalJsonStringify(selection)
    return {
      ...binding,
      async withModels<Result>(use: (models: Models) => Promise<Result>): Promise<Result> {
        const current = await options.selectionService.resolveSelection({
          ...reference,
          workspaceId,
        })
        if (canonicalJsonStringify(current) !== pinned)
          throw new Error('PI_PROVIDER_BINDING_CHANGED')
        await options.selectionService.assertReady(current)
        return options.selectionService.withCredential(
          current,
          {
            requestId: plan.correlation.requestId,
            principalRef: options.leasePrincipalRef,
            policySnapshot: plan.constraints.policySnapshot,
          },
          async (value) => {
            let secret: string | undefined = value
            const models = createModels({
              authContext: { env: async () => undefined, fileExists: async () => false },
              credentials: {
                read: async () => undefined,
                list: async () => [],
                modify: async () => {
                  throw new Error('PI_CREDENTIAL_PERSISTENCE_DISABLED')
                },
                delete: async () => {
                  throw new Error('PI_CREDENTIAL_PERSISTENCE_DISABLED')
                },
              },
            })
            models.setProvider(
              createProvider({
                id: binding.provider,
                baseUrl: 'https://api.openai.com/v1',
                models: [selected],
                api: openAIResponsesApi(),
                auth: {
                  apiKey: {
                    name: 'Gateway credential lease',
                    resolve: async () => {
                      if (!secret) throw new Error('PI_CREDENTIAL_LEASE_CLOSED')
                      return { auth: { apiKey: secret } }
                    },
                  },
                },
              })
            )
            try {
              return await use(models)
            } finally {
              secret = undefined
              models.clearProviders()
            }
          }
        )
      },
    }
  }
}

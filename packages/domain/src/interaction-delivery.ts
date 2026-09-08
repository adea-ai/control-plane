import { IdentifierSchemas } from '@control-plane/contracts'
import type { CommandAcceptanceRepository } from './command-inbox.js'
import {
  InteractionResponseInputSchema,
  InteractionService,
  type InteractionRepository,
  type InteractionRequest,
} from './interactions.js'

export const ScopedInteractionResponseSchema = InteractionResponseInputSchema.omit({
  respondingPrincipalId: true,
  respondedAt: true,
})
  .extend({
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
  })
  .strict()

export interface InteractionSignalDispatcher {
  /** Implementations must preserve response identity when retrying ambiguous delivery. */
  deliver(
    request: InteractionRequest & { response: NonNullable<InteractionRequest['response']> }
  ): Promise<void>
}

/** Shared by authenticated entrypoints; durable response storage precedes signal delivery. */
export class DurableInteractionDeliveryService {
  constructor(
    readonly interactions: InteractionRepository,
    readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId' | 'getExecution'>,
    readonly dispatcher: InteractionSignalDispatcher,
    readonly now: () => string = () => new Date().toISOString()
  ) {}

  async respond(input: unknown, authenticatedPrincipalId: string): Promise<InteractionRequest> {
    const parsed = await this.authorize(input, authenticatedPrincipalId)
    const saved = await new InteractionService(this.interactions).respond({
      ...parsed,
      respondingPrincipalId: authenticatedPrincipalId,
      respondedAt: this.now(),
    })
    if (!saved.response) throw new Error('INTERACTION_DELIVERY_RESPONSE_MISSING')
    // Sending the stored response, rather than caller input, preserves replay identity.
    await this.dispatcher.deliver({ ...saved, response: saved.response })
    return saved
  }

  /** Confirmed receipt replay checks ownership without requiring a still-active attempt. */
  async authorize(input: unknown, authenticatedPrincipalId: string, requireActive = true) {
    const parsed = ScopedInteractionResponseSchema.parse(input)
    const [command, execution, interaction] = await Promise.all([
      this.commands.getByExecutionId(parsed.executionId),
      this.commands.getExecution(parsed.executionId),
      this.interactions.get(parsed.interactionId),
    ])
    if (
      !command ||
      !execution ||
      !interaction ||
      command.executionId !== parsed.executionId ||
      command.workspaceId !== parsed.workspaceId ||
      command.projectId !== parsed.projectId ||
      execution.correlation.workspaceId !== parsed.workspaceId ||
      execution.correlation.projectId !== parsed.projectId ||
      interaction.executionId !== parsed.executionId ||
      interaction.attemptId !== parsed.attemptId ||
      !interaction.allowedPrincipalIds.includes(authenticatedPrincipalId)
    )
      throw new Error('INTERACTION_DELIVERY_SCOPE_REJECTED')
    if (
      requireActive &&
      (execution.latestAttemptId !== parsed.attemptId ||
        (execution.state !== 'running' && execution.state !== 'awaiting_input'))
    )
      throw new Error('INTERACTION_DELIVERY_EXECUTION_INACTIVE')
    return parsed
  }
}

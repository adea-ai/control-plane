import { isDeepStrictEqual } from 'node:util'
import {
  InteractionResponseCommandSchema,
  InteractionResponseCommandResultSchema,
  type InteractionResponseCommand,
  type InteractionResponseCommandResult,
} from '@control-plane/contracts'
import {
  interactionCommandScopeKey,
  type InteractionCommandReceipt,
  type InteractionCommandRepository,
} from './interaction-command.js'
import type { DurableInteractionDeliveryService } from './interaction-delivery.js'

export class DurableInteractionCommandService {
  constructor(
    readonly receipts: InteractionCommandRepository,
    readonly delivery: DurableInteractionDeliveryService,
    readonly now: () => string = () => new Date().toISOString()
  ) {}

  async respond(
    input: unknown,
    authenticatedPrincipalId: string
  ): Promise<InteractionResponseCommandResult> {
    const request = InteractionResponseCommandSchema.parse(input)
    if (request.caller.servicePrincipalId !== authenticatedPrincipalId)
      throw new Error('INTERACTION_COMMAND_CALLER_MISMATCH')
    const existing = await this.receipts.get(request)
    // Never reserve a key or return a receipt before verifying current ownership.
    await this.delivery.authorize(
      toResponse(request),
      authenticatedPrincipalId,
      existing?.acceptedAt === undefined
    )
    if (existing) assertSameCommand(request, existing)
    const reservation =
      existing === undefined
        ? await this.receipts.reserve({ request })
        : { receipt: existing, inserted: false }
    const receipt = reservation.receipt
    assertSameCommand(request, receipt)
    if (receipt.acceptedAt === undefined) {
      await this.delivery.respond(toResponse(receipt.request), authenticatedPrincipalId)
      await this.receipts.markAccepted(request, this.now())
    }
    return InteractionResponseCommandResultSchema.parse({
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      correlation: request.correlation,
      data: {
        commandId: receipt.request.commandId,
        responseId: receipt.request.commandId,
        executionId: receipt.request.payload.executionId,
        attemptId: receipt.request.payload.attemptId,
        interactionId: receipt.request.payload.interactionId,
        status: 'accepted',
        replayed: !reservation.inserted,
      },
    })
  }
}

function toResponse(request: InteractionResponseCommand) {
  return {
    ...request.payload,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    responseId: request.commandId,
  }
}

function assertSameCommand(
  request: InteractionCommandReceipt['request'],
  receipt: InteractionCommandReceipt
): void {
  // The supplied hash is not authority: compare the validated payload itself.
  if (
    interactionCommandScopeKey(request) !== interactionCommandScopeKey(receipt.request) ||
    !isDeepStrictEqual(request.payload, receipt.request.payload)
  )
    throw new Error('INTERACTION_COMMAND_PAYLOAD_CONFLICT')
}

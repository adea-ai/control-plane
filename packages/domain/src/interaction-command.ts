import { InteractionResponseCommandSchema } from '@control-plane/contracts'
import { z } from 'zod'

export const InteractionCommandScopeSchema = InteractionResponseCommandSchema.pick({
  workspaceId: true,
  projectId: true,
  caller: true,
  operation: true,
  idempotencyKey: true,
}).strip()
export const InteractionCommandReceiptSchema = z.strictObject({
  request: InteractionResponseCommandSchema,
  acceptedAt: z.iso.datetime().optional(),
})
export type InteractionCommandScope = z.output<typeof InteractionCommandScopeSchema>
export type InteractionCommandReceipt = z.output<typeof InteractionCommandReceiptSchema>

export interface InteractionCommandRepository {
  get(scope: InteractionCommandScope): Promise<InteractionCommandReceipt | undefined>
  /** Atomically retains the first request, including its response/command identity. */
  reserve(receipt: InteractionCommandReceipt): Promise<InteractionCommandReceipt>
  /** Records confirmed signal acceptance without changing the original request. */
  markAccepted(scope: InteractionCommandScope, at: string): Promise<InteractionCommandReceipt>
}

export function interactionCommandScopeKey(input: InteractionCommandScope): string {
  const scope = InteractionCommandScopeSchema.parse(input)
  return JSON.stringify([
    scope.caller.servicePrincipalId,
    scope.workspaceId,
    scope.projectId,
    scope.operation,
    scope.idempotencyKey,
  ])
}

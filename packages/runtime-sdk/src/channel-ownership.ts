import { z } from 'zod'

export const RuntimeChannelOwnershipSchema = z
  .object({
    nodeId: z.string().regex(/^rnr_[0-9A-HJKMNP-TV-Z]{26}$/),
    workspaceId: z.string().regex(/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/),
    gatewayInstanceId: z.string().min(1).max(256),
    connectionId: z.string().min(1).max(256),
    channelGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    protocolVersion: z
      .object({ major: z.number().int().nonnegative(), minor: z.number().int().nonnegative() })
      .strict(),
    connectedAt: z.iso.datetime(),
    lastHeartbeatAt: z.iso.datetime(),
  })
  .strict()
  .refine((record) => Date.parse(record.lastHeartbeatAt) >= Date.parse(record.connectedAt), {
    message: 'Heartbeat cannot precede connection',
  })

export type RuntimeChannelOwnership = z.output<typeof RuntimeChannelOwnershipSchema>

/** Durable fencing only; replacement notification is owned by the gateway coordinator. */
export interface RuntimeChannelOwnershipRepository {
  claim(
    record: RuntimeChannelOwnership
  ): Promise<{ accepted: boolean; previous?: RuntimeChannelOwnership }>
  lookup(nodeId: string): Promise<RuntimeChannelOwnership | undefined>
  heartbeat(record: RuntimeChannelOwnership): Promise<boolean>
  release(record: RuntimeChannelOwnership): Promise<boolean>
}

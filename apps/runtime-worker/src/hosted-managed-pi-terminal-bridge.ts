import { ManagedPiStatusSchema, type ManagedPiStatus } from '@control-plane/managed-pi-adapter'
import {
  GatewayCommandEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayCommandEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { z } from 'zod'
import { type HostedArtifactStore } from './hosted-managed-pi-schemas.js'

export interface HostedManagedPiTerminalBridgeOptions {
  readonly artifactStore: HostedArtifactStore
}

export class HostedManagedPiTerminalBridge {
  readonly #artifactStore: HostedArtifactStore

  constructor(options: HostedManagedPiTerminalBridgeOptions) {
    this.#artifactStore = options.artifactStore
  }

  async result(input: {
    readonly command: GatewayCommandEnvelope
    readonly status: ManagedPiStatus
    readonly sequence: number
  }): Promise<GatewayResultEnvelope | undefined> {
    const command = GatewayCommandEnvelopeSchema.parse(input.command)
    const status = ManagedPiStatusSchema.parse(input.status)
    const sequence = z.number().int().nonnegative().max(2_147_483_647).parse(input.sequence)
    const attemptId = z
      .string()
      .regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/)
      .parse(command.attemptId)
    if (sequence <= command.sequence) throw new Error('HOSTED_GATEWAY_SEQUENCE_STALE')

    if (
      status.state === 'queued' ||
      status.state === 'running' ||
      status.state === 'waiting_input' ||
      status.state === 'stopping' ||
      status.state === 'unknown'
    ) {
      return undefined
    }

    const common = {
      type: 'result' as const,
      schemaVersion: 1 as const,
      protocolVersion: command.protocolVersion,
      sequence,
      nodeId: command.nodeId,
      workspaceId: command.workspaceId,
      traceId: command.traceId,
      sentAt: status.observedAt,
      channelGeneration: command.channelGeneration,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      completedAt: status.observedAt,
    }
    if (status.state === 'succeeded') {
      const artifact = await this.#artifactStore.persist({
        attemptId,
        mediaType: 'application/json',
        value: z.json().parse(status.result),
      })
      return GatewayResultEnvelopeSchema.parse({
        ...common,
        status: 'succeeded',
        result: {
          artifact: {
            artifactId: artifact.artifactId,
            digest: artifact.digest,
            mediaType: artifact.mediaType,
            sizeBytes: artifact.sizeBytes,
          },
        },
      })
    }
    if (status.state === 'cancelled') {
      return GatewayResultEnvelopeSchema.parse({
        ...common,
        status: 'cancelled',
        result: { data: {} },
      })
    }
    return GatewayResultEnvelopeSchema.parse({
      ...common,
      status: 'failed',
      result: { data: { error: status.error } },
    })
  }
}

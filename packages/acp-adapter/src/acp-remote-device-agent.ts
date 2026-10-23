import {
  GatewayArtifactReferenceSchema,
  GatewayCommandEnvelopeSchema,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { z } from 'zod'
import { canonicalJson, utf8 } from './acp-remote-crypto.ts'
import {
  ACP_REMOTE_SEALED_REPLY_MEDIA_TYPE,
  readSealedCarrierPayload,
  readSealedHeaderProjection,
} from './acp-remote-sealed-frame.ts'
import { ACP_REMOTE_SEALED_OPERATION } from './acp-remote-wire.ts'
import type { AcpRemoteSealedResponse } from './acp-remote-transport.ts'

/** The artifact reference shape the gateway protocol publishes. */
export type GatewayArtifactReference = z.output<typeof GatewayArtifactReferenceSchema>

/**
 * Device-side agent that answers one sealed ACP command.
 *
 * The device endpoint already authenticates, decrypts, fences and executes a sealed command, and
 * it already publishes a byte-identical replay for a repeated command identity. What was missing
 * was the thing that receives a carrier command on the device side, checks that the carrier did
 * not redirect the sealed command to another route, runs it, and hands the sealed reply back as
 * the carrier command's SINGLE per-command result artifact.
 *
 * The reply artifact uses the gateway's existing attempt-scoped convention
 * (`runtime-results/<attemptId>/result.json`, artifact id `art_<attemptId suffix>`), so the
 * gateway's `RuntimeCommandArtifactVerifier` verifies the sealed reply with no protocol change and
 * the one-artifact-per-attempt invariant keeps holding.
 */

/** The device surface the agent drives. */
export interface AcpRemoteSealedDevice {
  handleCommand(input: unknown): Promise<AcpRemoteSealedResponse>
}

/**
 * Narrow artifact-store port. The production object store satisfies it structurally; the reply
 * artifact must be readable by the gateway under the attempt-scoped key.
 */
export interface AcpRemoteReplyArtifactStore {
  put(input: {
    readonly key: string
    readonly body: Uint8Array
    readonly contentType?: string
    readonly metadata?: Readonly<Record<string, string>>
  }): Promise<{
    readonly size: number
    readonly contentType?: string
    readonly sha256: `sha256:${string}`
  }>
}

export interface AcpRemoteDeviceAgentOptions {
  readonly device: AcpRemoteSealedDevice
  readonly artifacts: AcpRemoteReplyArtifactStore
}

export interface AcpRemoteDeviceAgentResult {
  readonly status: 'succeeded'
  readonly result: { readonly artifact: GatewayArtifactReference }
}

/** Attempt-scoped reply artifact key. Matches the gateway's result-artifact verifier exactly. */
export function acpRemoteReplyArtifactKey(attemptId: string): string {
  return `runtime-results/${attemptId}/result.json`
}

/** Attempt-scoped reply artifact id. Matches the gateway's result-artifact verifier exactly. */
export function acpRemoteReplyArtifactId(attemptId: string): string {
  return `art_${attemptId.slice(4)}`
}

/**
 * Answers ONE sealed carrier command.
 *
 * The agent is the device's trust boundary against the relay: the gateway may drop, delay or
 * duplicate a carrier command, but it may not redirect it. The sealed header names the workspace,
 * node and runtime connection the command was sealed for, and the agent refuses anything that does
 * not match the carrier it arrived in.
 */
export async function handleAcpRemoteCarrierCommand(
  options: AcpRemoteDeviceAgentOptions,
  commandValue: unknown
): Promise<AcpRemoteDeviceAgentResult> {
  const command: GatewayCommandEnvelope = GatewayCommandEnvelopeSchema.parse(commandValue)
  if (command.operation !== ACP_REMOTE_SEALED_OPERATION) {
    throw new Error('ACP_REMOTE_CARRIER_OPERATION_UNSUPPORTED')
  }
  if (command.attemptId === undefined) {
    throw new Error('ACP_REMOTE_CARRIER_ATTEMPT_MISSING')
  }
  const sealed = readSealedCarrierPayload(command.payload)
  const header = readSealedHeaderProjection(sealed)
  // Relay binding: the sealed command must name the same route as the carrier that carried it.
  // A gateway that redirected the carrier cannot redirect the sealed command, because the sealed
  // header is what the device authenticates against.
  if (
    header.workspaceId !== command.workspaceId ||
    header.nodeId !== command.nodeId ||
    header.runtimeConnectionId !== command.runtimeConnectionId
  ) {
    throw new Error('ACP_REMOTE_CARRIER_BINDING_MISMATCH')
  }
  // Generation binding: a command sealed for another channel generation is not this channel's
  // command. The device fence would refuse it later; refusing here keeps the effect unstarted.
  if (header.channelGeneration !== command.channelGeneration) {
    throw new Error('ACP_REMOTE_CARRIER_STALE_CHANNEL')
  }
  const reply = await options.device.handleCommand(sealed)
  const body = utf8(canonicalJson(reply))
  const descriptor = await options.artifacts.put({
    key: acpRemoteReplyArtifactKey(command.attemptId),
    body,
    contentType: ACP_REMOTE_SEALED_REPLY_MEDIA_TYPE,
    metadata: { attempt: command.attemptId },
  })
  return {
    status: 'succeeded',
    result: {
      artifact: GatewayArtifactReferenceSchema.parse({
        artifactId: acpRemoteReplyArtifactId(command.attemptId),
        digest: descriptor.sha256,
        mediaType: descriptor.contentType ?? ACP_REMOTE_SEALED_REPLY_MEDIA_TYPE,
        sizeBytes: descriptor.size,
      }),
    },
  }
}

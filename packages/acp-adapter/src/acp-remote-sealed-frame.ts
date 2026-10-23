import { z } from 'zod'
import {
  ACP_REMOTE_SUITE,
  canonicalJson,
  decodeBase64Url,
  encodeBase64Url,
  utf8,
  utf8Decode,
} from './acp-remote-crypto.ts'

/**
 * Carrier framing for one sealed ACP command or reply.
 *
 * The gateway relays these bytes without ever being able to read them: a sealed command is HPKE
 * ciphertext bound to the device recipient key, and a sealed reply is HPKE ciphertext bound to the
 * per-command ephemeral return key. The carrier therefore carries an OPAQUE blob and nothing else:
 * the gateway learns the route, the command identity and the timing, and never the prompt, the
 * arguments or the result.
 *
 * The framing lives in one module so the controller wire and the device agent agree on ONE
 * encoding instead of each inventing one. The sealed header projection below is deliberately a
 * NARROW view: the authoritative sealed-command schema lives with the transport, and the drift
 * test in `acp-remote-wire.test.mjs` pins the projection against a real sealed command.
 */

/** Payload key that carries the opaque sealed blob. It names no privileged local selector. */
export const ACP_REMOTE_SEALED_PAYLOAD_KEY = 'acpRemoteSealed'

/** Media type recorded for the per-command reply artifact. */
export const ACP_REMOTE_SEALED_REPLY_MEDIA_TYPE = 'application/json'

/**
 * Narrow projection of the sealed command header that the carrier and the device agent need:
 * route identity, the command identity that binds the reply, and the validity window.
 *
 * This is a PROJECTION, not the authoritative header: the transport owns the full sealed-command
 * schema, and this object deliberately keeps only the fields the carrier and the device need. It
 * is therefore non-strict — the authoritative header carries more fields than the carrier reads,
 * and the drift test pins this projection against a real sealed command.
 */
export const AcpRemoteSealedHeaderProjectionSchema = z.object({
  suite: z.literal(ACP_REMOTE_SUITE),
  workspaceId: z.string().regex(/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/),
  nodeId: z.string().regex(/^rnr_[0-9A-HJKMNP-TV-Z]{26}$/),
  runtimeConnectionId: z.string().regex(/^rtc_[0-9A-HJKMNP-TV-Z]{26}$/),
  commandId: z.string().regex(/^cmd_[0-9A-HJKMNP-TV-Z]{26}$/),
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  channelGeneration: z.number().int().positive(),
})

export type AcpRemoteSealedHeaderProjection = z.output<typeof AcpRemoteSealedHeaderProjectionSchema>

/** Encodes one sealed frame as an opaque base64url string. */
export function encodeSealedFrame(value: unknown): string {
  return encodeBase64Url(utf8(canonicalJson(value)))
}

/**
 * Decodes one opaque sealed frame. A malformed frame is a decode failure, never a partially
 * recovered value: the caller must treat it as an untrusted reply.
 */
export function decodeSealedFrame(value: string): unknown {
  return JSON.parse(utf8Decode(decodeBase64Url(value)))
}

/** Builds the carrier payload that carries one opaque sealed frame. */
export function buildSealedCarrierPayload(sealed: unknown): {
  readonly version: number
  readonly parameters: Record<string, string>
} {
  return {
    version: 1,
    parameters: { [ACP_REMOTE_SEALED_PAYLOAD_KEY]: encodeSealedFrame(sealed) },
  }
}

/**
 * Reads the opaque sealed frame back out of a carrier payload.
 *
 * The payload is a relay carrier, not a command: only the single opaque key is accepted, and any
 * other parameter is a framing error rather than something to forward.
 */
export function readSealedCarrierPayload(payload: unknown): unknown {
  const parsed = z
    .object({
      version: z.number().int().positive(),
      parameters: z.record(z.string(), z.json()),
    })
    .strict()
    .safeParse(payload)
  if (!parsed.success) throw new Error('ACP_REMOTE_CARRIER_PAYLOAD_INVALID')
  const keys = Object.keys(parsed.data.parameters)
  if (keys.length !== 1 || keys[0] !== ACP_REMOTE_SEALED_PAYLOAD_KEY) {
    throw new Error('ACP_REMOTE_CARRIER_PAYLOAD_INVALID')
  }
  const encoded = parsed.data.parameters[ACP_REMOTE_SEALED_PAYLOAD_KEY]
  if (typeof encoded !== 'string') throw new Error('ACP_REMOTE_CARRIER_PAYLOAD_INVALID')
  return decodeSealedFrame(encoded)
}

/**
 * Reads the narrow sealed-header projection out of a decoded sealed frame.
 *
 * The frame itself stays opaque to the gateway: only the DEVICE side reads the header, because the
 * header is the routing information the device needs to bind the command to its own route.
 */
export function readSealedHeaderProjection(frame: unknown): AcpRemoteSealedHeaderProjection {
  const sealed = z.object({ header: z.unknown() }).passthrough().safeParse(frame)
  if (!sealed.success) throw new Error('ACP_REMOTE_SEALED_FRAME_INVALID')
  const header = AcpRemoteSealedHeaderProjectionSchema.safeParse(sealed.data.header)
  if (!header.success) throw new Error('ACP_REMOTE_SEALED_HEADER_INVALID')
  return header.data
}

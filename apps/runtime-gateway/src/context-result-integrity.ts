import { createHash } from 'node:crypto'
import { GatewayResultEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'

export function contextCommandCompletionDigest(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalContextJson(input)).digest('hex')}`
}

export function contextCommandResultDigest(input: unknown): string {
  // Hash only the original semantic fields, including for reconstructed
  // Artifact frames without transport headers. Full wire validation occurs
  // at ingestion; picking from its refined schema is not supported by Zod.
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('CONTEXT_COMMAND_RESULT_INVALID')
  }
  const fields = GatewayResultEnvelopeSchema.shape
  const candidate = input as Record<string, unknown>
  const result = {
    payloadHash: fields.payloadHash.parse(candidate['payloadHash']),
    status: fields.status.parse(candidate['status']),
    completedAt: fields.completedAt.parse(candidate['completedAt']),
    result: fields.result.parse(candidate['result']),
  }
  return contextCommandCompletionDigest({
    type: 'result',
    payloadHash: result.payloadHash,
    status: result.status,
    completedAt: result.completedAt,
    result: result.result,
  })
}

export function canonicalContextJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalContextJson).join(',')}]`
  if (input && typeof input === 'object')
    return `{${Object.entries(input)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalContextJson(value)}`)
      .join(',')}}`
  return JSON.stringify(input) ?? 'undefined'
}

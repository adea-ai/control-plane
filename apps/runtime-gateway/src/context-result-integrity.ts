import { createHash } from 'node:crypto'
import { GatewayResultEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'

export function contextCommandCompletionDigest(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalContextJson(input)).digest('hex')}`
}

export function contextCommandResultDigest(input: unknown): string {
  const result = GatewayResultEnvelopeSchema.pick({
    payloadHash: true,
    status: true,
    completedAt: true,
    result: true,
  })
    .strip()
    .parse(input)
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

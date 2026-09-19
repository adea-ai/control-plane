import { createHash } from 'node:crypto'

/**
 * Pure helpers shared by the vault engine and the encrypted providers.
 * Behavior-copied verbatim from the pre-Effect implementation; see legacy.ts.
 */

export function assertSecret(secret: string): void {
  if (secret.length < 8 || secret.length > 65_536) throw new Error('INVALID_SECRET')
}

const sensitiveKey =
  /^(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)$/i

export function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret)
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret))
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, entry]) => sensitiveKey.test(key) || containsSecret(entry, secret)
  )
}

export function hash(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(serialized).digest('hex')
}

export function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

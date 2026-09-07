import type { SpanOutcome } from './types.js'

const sensitiveKeys = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'awssecretaccesskey',
  'clientsecret',
  'cookie',
  'credential',
  'credentialref',
  'encryptionkey',
  'filecontent',
  'filecontents',
  'idtoken',
  'modelinput',
  'passwd',
  'password',
  'privatekey',
  'prompt',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'secretvalue',
  'signingkey',
  'token',
  'toolinput',
])
const secretsInText = [
  {
    pattern:
      /(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential(?:[_-]?ref)?|encryption[_-]?key|file[_-]?contents?|id[_-]?token|model[_-]?input|passw(?:or)?d|private[_-]?key|prompt|refresh[_-]?token|secret(?:[_-]?(?:access[_-]?key|key|value))?|signing[_-]?key|token|tool[_-]?input)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
    replacement: '$1=[REDACTED]',
  },
  { pattern: /\bBearer\s+[^\s,;]+/gi, replacement: 'Bearer [REDACTED]' },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/g,
    replacement: '[REDACTED]',
  },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replacement: '[REDACTED]' },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/:]+:[^@\s]+@/gi,
    replacement: '$1[REDACTED]@',
  },
  {
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: '[REDACTED]',
  },
] as const

function redactText(value: string): string {
  return secretsInText.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    value
  )
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())
}

export function redactTelemetryValue(value: unknown): unknown {
  return redact(value, new WeakSet<object>())
}

export function sanitizeSpanOutcome(outcome: SpanOutcome): SpanOutcome {
  if (outcome.status !== 'error' || outcome.error === undefined) {
    return { status: outcome.status }
  }
  return { status: 'error', error: redactTelemetryValue(outcome.error) }
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? '[REDACTED]' : redact(nested, seen)
  }
  return result
}

export function sanitizeAttributes(
  attributes: Readonly<Record<string, unknown>>
): Readonly<Record<string, boolean | number | string>> {
  const sanitized: Record<string, boolean | number | string> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (isSensitiveKey(key)) sanitized[key] = '[REDACTED]'
    else if (typeof value === 'boolean' || typeof value === 'number') sanitized[key] = value
    else if (typeof value === 'string') sanitized[key] = redactText(value)
  }
  return sanitized
}

const diagnosticRedactedValue = '[REDACTED]'
const diagnosticCircularValue = '[Circular]'
const diagnosticSensitiveKey =
  /authorization|cookie|credential|password|private.?key|secret|token|api.?key/i

export function redactDiagnostics(value: unknown, additionalKeys: readonly string[] = []): unknown {
  const explicitKeys = new Set(additionalKeys.map(normalizeDiagnosticKey))
  return redactDiagnosticValue(value, explicitKeys, new WeakSet())
}

function redactDiagnosticValue(
  value: unknown,
  explicitKeys: ReadonlySet<string>,
  seen: WeakSet<object>
): unknown {
  if (value instanceof Error) return { name: value.name, message: 'Service operation failed' }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return diagnosticCircularValue
  seen.add(value)

  if (Array.isArray(value))
    return value.map((item) => redactDiagnosticValue(item, explicitKeys, seen))

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveDiagnosticKey(key, explicitKeys)
        ? diagnosticRedactedValue
        : redactDiagnosticValue(item, explicitKeys, seen),
    ])
  )
}

function isSensitiveDiagnosticKey(key: string, explicitKeys: ReadonlySet<string>): boolean {
  return diagnosticSensitiveKey.test(key) || explicitKeys.has(normalizeDiagnosticKey(key))
}

function normalizeDiagnosticKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase()
}

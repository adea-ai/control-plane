// Bounded, sanitized diagnostics for the PostgreSQL disruption drill's
// readiness probe.
//
// The probe asks the compose service whether PostgreSQL accepts connections
// again after the service is restarted. While the container is still
// initialising, the check answers with a non-zero exit status and a message
// that says why: the socket does not exist yet, or the database system is
// starting up or shutting down. A probe that only reports "did not recover
// within 30 seconds" throws that detail away, so the operator cannot tell a
// service that is still initialising from one that never started, from a
// missing executable, or from a host that is out of space.
//
// Everything here is bounded and free of credentials: a fixed excerpt
// length, a redacted copy of the probe's output, and a fixed set of fields.

/**
 * The recovery ceiling the disruption drill keeps: the probe waits this long
 * for PostgreSQL to accept connections again after the service is restarted.
 * It is a ceiling, not a target, and the diagnostics never raise it.
 */
export const POSTGRES_RECOVERY_CEILING_SECONDS = 30

/** The longest excerpt of probe output a diagnostic keeps. */
export const PROBE_EXCERPT_LIMIT = 400

/**
 * The characters a credential key is made of.
 */
const KEY_CHARACTER = /[A-Za-z0-9_.-]/

/**
 * The ends of a credential key.
 *
 * A key may carry a prefix, so `my_password` is a credential key too, and the
 * check is on the end of the key.
 */
const CREDENTIAL_KEY_ENDS = [
  'pgpassword',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
]

/**
 * Whether a character is whitespace.
 *
 * These are the six ASCII whitespace characters, and they are the ones
 * libpq's own parser treats as whitespace: the space, the tab, the line feed,
 * the carriage return, the vertical tab and the form feed. A scanner that
 * knows only four of them reads a value that libpq would read quite
 * differently, and a value that libpq accepts can then be published.
 */
function isWhitespace(character) {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\v' ||
    character === '\f'
  )
}

/** Whether a key ends with a credential word. */
function isCredentialKey(key) {
  const lower = key.toLowerCase()
  return CREDENTIAL_KEY_ENDS.some((end) => lower.endsWith(end))
}

/** The end of the maximal run of key characters that starts at `start`. */
function readKeyEnd(source, start) {
  let index = start
  while (index < source.length && KEY_CHARACTER.test(source[index])) index += 1
  return index
}

/**
 * The end of the run of whitespace that starts at `start`.
 *
 * libpq permits whitespace around the `=`, so the value of a credential key
 * may start after it. That whitespace belongs to the value: a value read from
 * the whitespace would be empty, and the scan would then walk on and expose
 * the value that follows it. The same tolerance is given to the `:` that
 * introduces the password of a connection URI.
 */
function skipWhitespace(source, start) {
  let index = start
  while (index < source.length && isWhitespace(source[index])) index += 1
  return index
}

/**
 * The end of a credential value that starts at `start`.
 *
 * A quoted value is consumed whole, with its escapes, so a password that holds
 * a space cannot leave its tail behind. A value whose closing quote is never
 * there takes the rest of the source. An unquoted value runs to the next
 * whitespace, except that a backslash escapes the next character: that is how
 * libpq writes an unquoted value that holds a space, so `password=two\ words`
 * is one value and not two.
 */
function readValueEnd(source, start, stopCharacters) {
  const quote = source[start]
  if (quote === '"' || quote === "'") {
    let index = start + 1
    while (index < source.length) {
      const character = source[index]
      if (character === '\\') {
        index += 2
        continue
      }
      if (character === quote) return index + 1
      index += 1
    }
    return source.length
  }
  let index = start
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (isWhitespace(character)) break
    if (stopCharacters !== undefined && stopCharacters.has(character)) break
    index += 1
  }
  return Math.min(index, source.length)
}

/**
 * The credential of a connection URI that starts at `start`, which is the first
 * character after `://`.
 *
 * A URI is not a connection string, and libpq parses the two differently. Its
 * own URI parser reads the authority raw: the authority ends at the first `/`
 * or `?`, the userinfo is the part of the authority before the first `@`, and
 * the password is the raw text that follows the first `:` of the userinfo. A
 * quote and a backslash have no meaning in a URI, so `user:'abc'def` is a
 * password of `'abc'def` and a backslash before the `@` does not escape it.
 * An authority with no `@` is a host and a port and holds no password, and an
 * authority with no `:` holds a user and no password.
 *
 * The scan that failed is reported with the place it reached, so the text it
 * covered is not scanned again.
 */
function readUriCredential(source, start) {
  let authorityEnd = start
  while (
    authorityEnd < source.length &&
    source[authorityEnd] !== '/' &&
    source[authorityEnd] !== '?'
  ) {
    authorityEnd += 1
  }
  let userinfoEnd = start
  while (userinfoEnd < authorityEnd && source[userinfoEnd] !== '@') userinfoEnd += 1
  if (userinfoEnd >= authorityEnd) return { matched: false, end: authorityEnd }
  let separator = start
  while (separator < userinfoEnd && source[separator] !== ':') separator += 1
  if (separator >= userinfoEnd) return { matched: false, end: userinfoEnd }
  return { matched: true, end: userinfoEnd + 1 }
}

/**
 * Redacts credentials from probe output and caps its length.
 *
 * The probe runs inside the compose service, so its output normally holds a
 * socket path and a database name. It can also hold a connection string, a
 * `PGPASSWORD` assignment, a quoted password with a space in it, or a long
 * opaque token, so those are redacted before the text is kept.
 *
 * The text is read once, from left to right, and every character is looked at
 * a bounded number of times: a key is read as one run, a value is read as one
 * run, and a scan that covered text is not repeated. A long plain token
 * therefore costs one pass and not one pass per position.
 *
 * The redaction runs before the excerpt is cut, so a secret can never be
 * split by the cut, and a value is consumed whole so its tail cannot survive
 * the redaction.
 */
export function sanitizeProbeOutput(text, limit = PROBE_EXCERPT_LIMIT) {
  if (text === undefined || text === null) return ''
  const source = String(text)
  const pieces = []
  let index = 0
  while (index < source.length) {
    if (source.startsWith('://', index)) {
      const credential = readUriCredential(source, index + 3)
      pieces.push(credential.matched ? '://<redacted>@' : source.slice(index, credential.end))
      index = credential.end
      continue
    }
    if (KEY_CHARACTER.test(source[index])) {
      const keyEnd = readKeyEnd(source, index)
      const key = source.slice(index, keyEnd)
      let afterKey = keyEnd
      while (afterKey < source.length && isWhitespace(source[afterKey])) afterKey += 1
      if (isCredentialKey(key) && source[afterKey] === '=') {
        const valueStart = skipWhitespace(source, afterKey + 1)
        const valueEnd = readValueEnd(source, valueStart)
        pieces.push(`${key}${source.slice(keyEnd, afterKey)}=<redacted>`)
        index = valueEnd
        continue
      }
      pieces.push(key)
      index = keyEnd
      continue
    }
    pieces.push(source[index])
    index += 1
  }
  // A long opaque token is redacted too: it is a single run of characters, so
  // the rule costs one pass.
  return pieces
    .join('')
    .replace(/\b[a-f0-9]{32,}\b/gi, '<redacted>')
    .trim()
    .slice(0, limit)
}

/**
 * Describes a readiness probe that never succeeded.
 *
 * The fields are the ones an operator needs to tell the causes apart: how
 * many attempts were made, how long the probe waited, the exit status of the
 * last attempt that produced one and the message that attempt wrote, the
 * last error the spawn reported, and the state the compose service was in.
 * An attempt that timed out produces no exit status and no message, so the
 * status and the message describe the same attempt and the spawn error is
 * reported on its own.
 */
export function describePostgresProbeFailure({
  attempts = 0,
  elapsedMs = 0,
  status = null,
  stderr = '',
  error = null,
  containerState = '',
}) {
  const fields = [
    `attempts=${attempts}`,
    `elapsedMs=${elapsedMs}`,
    `lastExitStatus=${status === null || status === undefined ? 'none' : String(status)}`,
  ]
  const lastError = sanitizeProbeOutput(error)
  if (lastError !== '') fields.push(`lastSpawnError=${lastError}`)
  const lastStderr = sanitizeProbeOutput(stderr)
  if (lastStderr !== '') fields.push(`lastStderr=${lastStderr}`)
  const state = sanitizeProbeOutput(containerState)
  if (state !== '') fields.push(`containerState=${state}`)
  return fields.join(' ')
}

/**
 * Whether a spawn failure is the probe's own per-attempt timeout.
 *
 * A readiness check that is still waiting for the service answers with a
 * timeout, and that is a service that is not ready yet. Any other spawn
 * failure — a missing executable, a permission error — is a hard failure the
 * operator has to see, not a service that is still starting.
 */
export function isProbeTimeout(error) {
  if (error === undefined || error === null) return false
  return error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM'
}

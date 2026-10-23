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
 * The two characters of a percent-encoded byte.
 */
const HEX_BYTE = /^[0-9A-Fa-f]{2}$/

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
 * libpq's own connection-string parser honours one quote and one escape: a
 * value that starts with a single quote runs to the closing single quote, and
 * a backslash escapes the next character in a value of either kind. A double
 * quote is an ordinary byte of a value, so `password="abc"def` is the value
 * `"abc"def` and not the value `"abc"` with `def` left behind.
 *
 * An unquoted value runs to the next of the six ASCII whitespace characters,
 * except that a backslash escapes the next character: that is how libpq writes
 * an unquoted value that holds a space, so `password=two\ words` is one value
 * and not two. A value whose closing quote is never there takes the rest of
 * the source.
 */
function readValueEnd(source, start) {
  if (source[start] === "'") {
    let index = start + 1
    while (index < source.length) {
      const character = source[index]
      if (character === '\\') {
        index += 2
        continue
      }
      if (character === "'") return index + 1
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
    index += 1
  }
  return Math.min(index, source.length)
}

/**
 * The schemes libpq's own parser accepts for a connection URI. It accepts
 * these two and nothing else, and it accepts them in lower case only.
 */
const URI_SCHEMES = ['postgres', 'postgresql']

/**
 * The searches the URI reader needs, kept between the candidates of one
 * redaction. The first `@`, the first `/` and the first `:` at or after a
 * position are each found once and reused while they are still ahead of the
 * next candidate, so a long authority costs one search and not one search per
 * candidate.
 */
function createUriSearch(source) {
  return { source, cached: new Map() }
}

/**
 * The first `text` at or after `from`, or -1 when there is none.
 */
function nextUriText(search, text, from) {
  let cached = search.cached.get(text)
  if (cached === undefined) {
    cached = { from: -1, found: -1 }
    search.cached.set(text, cached)
  }
  if (cached.from >= 0 && (cached.found === -1 ? from >= cached.from : from <= cached.found)) {
    return cached.found
  }
  cached.found = search.source.indexOf(text, from)
  cached.from = from
  return cached.found
}

/**
 * The first `text` at or after `from` and before `limit`, or -1 when there is
 * none.
 */
function nextUriTextWithin(search, text, from, limit) {
  const found = nextUriText(search, text, from)
  return found === -1 || found >= limit ? -1 : found
}

/**
 * The start of the next connection URI at or after `from`, or the end of the
 * source when there is none.
 *
 * A URI in diagnostic text ends where the next one begins. libpq's own parser
 * reads a whole connection string as one URI, but the redactor reads every URI
 * in the text on its own, and a URI whose searches ran past its own end would
 * take the next URI's password and the text between the two with it.
 */
function nextUriStart(source, search, from) {
  let start = -1
  for (const scheme of URI_SCHEMES) {
    const found = nextUriText(search, `${scheme}://`, from)
    if (found !== -1 && (start === -1 || found < start)) start = found
  }
  return start === -1 ? source.length : start
}

/**
 * The scheme of the connection URI that starts at `start`, or null when the
 * text there is not a URI libpq would read.
 */
function uriSchemeAt(source, start) {
  for (const scheme of URI_SCHEMES) {
    if (source.startsWith(`${scheme}://`, start)) return scheme
  }
  return null
}

/**
 * The percent-decoded form of a URI query key, or the key itself when it is
 * not a valid encoding.
 *
 * libpq decodes the key of a query parameter before it reads it, so the
 * parameter `%70assword=secret` is the option `password` with the value
 * `secret`, and a key that is left encoded would miss the credential. A key
 * that is not a valid encoding is one libpq rejects outright, and such a key
 * is kept as it is.
 */
function decodeUriKey(key) {
  if (!key.includes('%')) return key
  let decoded = ''
  for (let index = 0; index < key.length; index += 1) {
    const character = key[index]
    if (character !== '%') {
      decoded += character
      continue
    }
    const hex = key.slice(index + 1, index + 3)
    if (!HEX_BYTE.test(hex)) return key
    decoded += String.fromCharCode(Number.parseInt(hex, 16))
    index += 2
  }
  return decoded
}

/**
 * The credentials of a connection URI whose authority starts at `start`, and
 * the end of the URI.
 *
 * A URI is not a connection string, and libpq parses the two differently. Its
 * own URI parser reads the authority raw: the authority ends at the first `/`,
 * the userinfo is the part of the authority before the first `@`, and the
 * password is the raw text that follows the first `:` of the userinfo. A quote
 * and a backslash have no meaning in a URI, so `user:'abc'def` is a password
 * of `'abc'def` and a backslash before the `@` does not escape it. A `?` is
 * an ordinary character of the userinfo, so `user:ab?cd` is a password of
 * `ab?cd`.
 *
 * The query starts at the first `?` that follows the userinfo and is a list of
 * `key=value` parameters separated by `&`. libpq decodes the key of every
 * parameter before it reads it, so a key that decodes to a credential word
 * carries a credential, and the value of that parameter runs to the next `&`
 * or to the end of the source, exactly as libpq reads it.
 *
 * An authority with no `@` is a host and a port and holds no password, and an
 * authority with no `:` holds a user and no password. Either way the URI holds
 * no password, and the text is left to be read as ordinary text.
 *
 * A URI ends where the next one begins, and every search this reader makes is
 * bounded by that end. A search that ran into the next URI would read that
 * URI's password as this one's, and the text between the two would be taken
 * with it and never examined.
 *
 * Every span is read once and the scans move forward, so a long query costs
 * one pass over the text and not one pass per parameter.
 */
function readUriCredential(source, search, start) {
  const spans = []
  // The end of this URI: the next URI in the text, or the end of the source.
  const limit = nextUriStart(source, search, start + 1)
  const at = nextUriTextWithin(search, '@', start, limit)
  const slash = nextUriTextWithin(search, '/', start, limit)
  // The userinfo is the part of the authority before the first `@`.
  const userinfoEnd = at !== -1 && (slash === -1 || slash > at) ? at : -1
  if (userinfoEnd !== -1) {
    const colon = nextUriTextWithin(search, ':', start, limit)
    if (colon !== -1 && colon < userinfoEnd) {
      spans.push({ start, end: userinfoEnd, resume: userinfoEnd + 1 })
    }
  }
  // The query starts at the first `?` that follows the userinfo: a `?` inside
  // the userinfo is an ordinary character of the password, and a URI with no
  // userinfo starts its query at the first `?` of the authority.
  const question = nextUriTextWithin(
    search,
    '?',
    userinfoEnd === -1 ? start : userinfoEnd + 1,
    limit
  )
  if (question !== -1) {
    let parameterStart = question + 1
    while (parameterStart < limit) {
      const ampersand = nextUriTextWithin(search, '&', parameterStart, limit)
      const parameterEnd = ampersand === -1 ? limit : ampersand
      const equals = nextUriTextWithin(search, '=', parameterStart, limit)
      if (equals !== -1 && equals < parameterEnd) {
        const key = decodeUriKey(source.slice(parameterStart, equals))
        if (isCredentialKey(key)) {
          spans.push({
            start: equals + 1,
            end: parameterEnd,
            resume: parameterEnd,
            queryKeyStart: parameterStart,
          })
        }
      }
      if (parameterEnd >= limit) break
      parameterStart = parameterEnd + 1
    }
  }
  if (spans.length === 0) return { matched: false }
  const last = spans[spans.length - 1]
  return { matched: true, end: last.resume, limit, spans }
}

/**
 * Reads complete ordinary connection-string credential values across the
 * diagnostic text. The values can overlap URI spans or cross an apparent URI
 * boundary: treating those grammars independently would expose the tail of a
 * value after another scanner redacted an embedded parameter.
 */
function readOrdinaryCredentialSpans(source, start, end, uriQueryKeyStarts) {
  const spans = []
  let index = start
  while (index < end) {
    if (KEY_CHARACTER.test(source[index])) {
      const keyEnd = readKeyEnd(source, index)
      const key = source.slice(index, keyEnd)
      let afterKey = keyEnd
      while (afterKey < end && isWhitespace(source[afterKey])) afterKey += 1
      if (
        isCredentialKey(key) &&
        !uriQueryKeyStarts.has(index) &&
        afterKey < end &&
        source[afterKey] === '='
      ) {
        const valueStart = skipWhitespace(source, afterKey + 1)
        const valueEnd = Math.min(readValueEnd(source, valueStart), end)
        spans.push({
          start: index,
          end: valueEnd,
          resume: valueEnd,
          prefix: `${key}${source.slice(keyEnd, afterKey)}=`,
        })
        index = valueEnd
        continue
      }
      index = keyEnd
      continue
    }
    index += 1
  }
  return spans
}

/** Merges overlapping credential ranges so one grammar cannot expose another's tail. */
function mergeRedactionSpans(spans) {
  const sorted = spans.toSorted((left, right) => left.start - right.start || left.end - right.end)
  const merged = []
  for (const span of sorted) {
    const previous = merged.at(-1)
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end)
      previous.resume = Math.max(previous.resume, span.resume)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
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
 * A connection URI and a connection string are two different grammars and are
 * read by two different scanners. A URI is recognised only at the scheme
 * libpq accepts, and its password is the raw text after the first `:` of the
 * userinfo; a connection string honours the single quote and the backslash
 * and no other. The query of a URI is read as libpq reads it too: the
 * parameters are separated by `&`, the key of each one is decoded before it
 * is compared with a credential word, and the value of a credential parameter
 * runs to the next `&` or to the end of the source. A URI ends where the next
 * one begins, so a URI in a line of diagnostic text never reaches into the one
 * after it. A URI that holds no password is ordinary text, so the scan
 * continues inside it and a credential that follows it is still found.
 *
 * The redaction runs before the excerpt is cut, so a secret can never be
 * split by the cut, and a value is consumed whole so its tail cannot survive
 * the redaction.
 */
export function sanitizeProbeOutput(text, limit = PROBE_EXCERPT_LIMIT) {
  if (text === undefined || text === null) return ''
  const source = String(text)
  const uriSearch = createUriSearch(source)
  const uriSpans = []
  const uriQueryKeyStarts = new Set()
  let index = 0
  while (index < source.length) {
    const scheme = uriSchemeAt(source, index)
    if (scheme !== null) {
      const credential = readUriCredential(source, uriSearch, index + scheme.length + 3)
      if (credential.matched) {
        uriSpans.push(...credential.spans)
        for (const span of credential.spans) {
          if (span.queryKeyStart !== undefined) uriQueryKeyStarts.add(span.queryKeyStart)
        }
      }
    }
    index += 1
  }
  const ordinarySpans = readOrdinaryCredentialSpans(source, 0, source.length, uriQueryKeyStarts)
  const spans = mergeRedactionSpans([...uriSpans, ...ordinarySpans])
  const pieces = []
  let cursor = 0
  for (const span of spans) {
    pieces.push(source.slice(cursor, span.start))
    if (span.prefix !== undefined) pieces.push(span.prefix)
    pieces.push('<redacted>')
    pieces.push(source.slice(span.end, span.resume))
    cursor = span.resume
  }
  pieces.push(source.slice(cursor))
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

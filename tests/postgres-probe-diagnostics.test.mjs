import { expect, test } from 'bun:test'
import {
  describePostgresProbeFailure,
  isProbeTimeout,
  POSTGRES_RECOVERY_CEILING_SECONDS,
  PROBE_EXCERPT_LIMIT,
  sanitizeProbeOutput,
} from '../scripts/postgres-probe-diagnostics.mjs'

// The disruption drill's readiness probe asks the compose service whether
// PostgreSQL accepts connections again after the service is restarted. While the
// container is still initialising the check answers with a non-zero exit status
// and a message that says why, and the drill used to discard both: a failure
// only reported "did not recover within 30 seconds", which cannot tell a
// service that is still starting from one that never started, from a missing
// executable, or from a host that is out of space. These checks pin that the
// detail is kept, that it is bounded, and that it carries no credential.

test('a failed probe reports the attempts, the wait, the exit status and the service message', () => {
  const description = describePostgresProbeFailure({
    attempts: 4,
    elapsedMs: 1_482,
    status: 2,
    stderr:
      'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory',
    containerState:
      'control-plane-postgres-1   postgres:18.6-alpine   Up 2 seconds (health: starting)',
  })
  expect(description).toContain('attempts=4')
  expect(description).toContain('elapsedMs=1482')
  expect(description).toContain('lastExitStatus=2')
  expect(description).toContain('lastStderr=psql: error: connection to server on socket')
  expect(description).toContain('containerState=control-plane-postgres-1')
})

test('a failed probe with no exit status still reports what it knows', () => {
  const description = describePostgresProbeFailure({
    attempts: 1,
    elapsedMs: 12,
    status: null,
    stderr: '',
    error: 'spawnSync docker ENOENT',
  })
  expect(description).toContain('attempts=1')
  expect(description).toContain('lastExitStatus=none')
  expect(description).toContain('lastSpawnError=spawnSync docker ENOENT')
  expect(description).not.toContain('lastStderr=')
  expect(description).not.toContain('containerState=')
})

test('probe output is bounded and carries no credential', () => {
  const credential = 'postgresql://control_plane_admin:hunter2@127.0.0.1:54329/postgres'
  const sanitized = sanitizeProbeOutput(`FATAL: could not connect to ${credential}`)
  expect(sanitized).not.toContain('hunter2')
  expect(sanitized).toContain('<redacted>')

  expect(sanitizeProbeOutput('PGPASSWORD=hunter2 db=postgres')).toBe(
    'PGPASSWORD=<redacted> db=postgres'
  )
  expect(sanitizeProbeOutput('token=abcdef123456')).toBe('token=<redacted>')
  expect(sanitizeProbeOutput('x'.repeat(5_000)).length).toBe(PROBE_EXCERPT_LIMIT)
})

// A quoted password holds a space, so a rule that stops at the first
// whitespace leaves the tail of the secret behind: `password='two words'`
// became `password=<redacted> words'`. Every quoted and escaped form has to
// be consumed whole, and a value whose quote is never closed has to take the
// rest of its line with it.
test('a quoted password leaves no tail behind', () => {
  const forms = [
    "password='two words'",
    'password="two words"',
    "password='two\\' words'",
    'password="two\\" words"',
    "password='two words",
    'password="two words',
  ]
  for (const form of forms) {
    const sanitized = sanitizeProbeOutput(form)
    expect(sanitized).not.toContain('two')
    expect(sanitized).not.toContain('words')
    expect(sanitized).toContain('<redacted>')
  }
})

test('a quoted password in a connection URI leaves no tail behind', () => {
  const sanitized = sanitizeProbeOutput(
    "postgresql://control_plane_admin:'two words'@127.0.0.1/postgres"
  )
  expect(sanitized).not.toContain('two')
  expect(sanitized).not.toContain('words')
  expect(sanitized).toContain('<redacted>')
})

test('a credential key with a prefix is redacted too', () => {
  expect(sanitizeProbeOutput('my_password=hunter2 db=postgres')).toBe(
    'my_password=<redacted> db=postgres'
  )
})

// libpq writes an unquoted value that holds a space with a backslash before
// the space, so `password=two\ words` is one value. A rule that stops at the
// first whitespace leaves "words" behind.
test('a libpq value with a backslash-escaped space is redacted whole', () => {
  const sanitized = sanitizeProbeOutput('password=two\\ words dbname=postgres')
  expect(sanitized).not.toContain('words')
  expect(sanitized).toBe('password=<redacted> dbname=postgres')
})

// libpq permits whitespace around the `=`, so a value may start after it.
// A rule that reads the value from the whitespace reads an empty value, and
// the scan then walks on and publishes the password that follows:
// `password= hunter2` became `password=<redacted> hunter2`. The separator
// whitespace belongs to the value, so it is consumed with it.
test('a value that starts after the separator whitespace is redacted whole', () => {
  const cases = [
    ['password= hunter2 dbname=postgres', 'hunter2', 'password=<redacted> dbname=postgres'],
    ['password=  hunter2 dbname=postgres', 'hunter2', 'password=<redacted> dbname=postgres'],
    ["password = 'two words' dbname=postgres", 'words', 'password =<redacted> dbname=postgres'],
    ['password= "two words" dbname=postgres', 'words', 'password=<redacted> dbname=postgres'],
    ['password= two\\ words dbname=postgres', 'words', 'password=<redacted> dbname=postgres'],
    ['PGPASSWORD= hunter2', 'hunter2', 'PGPASSWORD=<redacted>'],
    ['my_password= hunter2 db=postgres', 'hunter2', 'my_password=<redacted> db=postgres'],
  ]
  for (const [input, secret, expected] of cases) {
    const sanitized = sanitizeProbeOutput(input)
    expect(sanitized).not.toContain(secret)
    expect(sanitized).toBe(expected)
  }
})

// A tab is whitespace too, and a value that is only the separator whitespace
// is an empty value: nothing of it survives.
test('the separator whitespace is whitespace of any kind, and an empty value stays empty', () => {
  expect(sanitizeProbeOutput('password=\thunter2')).toBe('password=<redacted>')
  expect(sanitizeProbeOutput('password= ')).toBe('password=<redacted>')
  expect(sanitizeProbeOutput('password=\n')).toBe('password=<redacted>')
})

// A quoted value whose quote is never closed takes the rest of the source with
// it, and the separator whitespace does not change that.
test('a value that starts after the separator whitespace is consumed whole', () => {
  for (const form of ["password= 'two words", 'password= "two words']) {
    const sanitized = sanitizeProbeOutput(form)
    expect(sanitized).not.toContain('two')
    expect(sanitized).not.toContain('words')
    expect(sanitized).toBe('password=<redacted>')
  }
})

// The six ASCII whitespace characters, which are the ones libpq's own parser
// treats as whitespace: the space, the tab, the line feed, the carriage
// return, the vertical tab and the form feed. A scanner that knows only four
// of them reads a value that libpq would read quite differently, and a value
// that libpq accepts can then be published.
const ASCII_WHITESPACE = [
  ['space', ' '],
  ['tab', '\t'],
  ['line feed', '\n'],
  ['carriage return', '\r'],
  ['vertical tab', '\v'],
  ['form feed', '\f'],
]

// The values the matrix pairs with each of those characters: an unquoted one,
// a quoted one and an escaped one. The text that must not survive is the
// part of the value that a rule that stopped early would have left behind.
const SEPARATOR_WHITESPACE_VALUES = [
  ['an unquoted value', 'hunter2', 'hunter2'],
  ['a single quoted value', "'two words'", 'words'],
  ['a double quoted value', '"two words"', 'words'],
  ['an escaped value', 'two\\ words', 'words'],
]

// The matrix: every ASCII whitespace character, before and after the `=`, with
// a quoted, an unquoted and an escaped value. The whitespace before the `=` is
// part of the text and is kept; the whitespace after it belongs to the value
// and is consumed with it.
const SEPARATOR_WHITESPACE_CASES = []
for (const [name, whitespace] of ASCII_WHITESPACE) {
  for (const [kind, value, secret] of SEPARATOR_WHITESPACE_VALUES) {
    SEPARATOR_WHITESPACE_CASES.push([
      `${name} before the = with ${kind}`,
      `password${whitespace}=${value} dbname=postgres`,
      secret,
      `password${whitespace}=<redacted> dbname=postgres`,
    ])
    SEPARATOR_WHITESPACE_CASES.push([
      `${name} after the = with ${kind}`,
      `password=${whitespace}${value} dbname=postgres`,
      secret,
      'password=<redacted> dbname=postgres',
    ])
  }
}

test.each(SEPARATOR_WHITESPACE_CASES)('%s is redacted whole', (_case, input, secret, expected) => {
  const sanitized = sanitizeProbeOutput(input)
  expect(sanitized).not.toContain(secret)
  expect(sanitized).toBe(expected)
})

// The same six characters around the `:` of a connection URI, whose password
// runs to the `@`. The user part is one token, but the `:` that introduces the
// password may follow whitespace, and the password may start after it.
const URI_WHITESPACE_CASES = []
for (const [name, whitespace] of ASCII_WHITESPACE) {
  for (const [kind, value, secret] of SEPARATOR_WHITESPACE_VALUES) {
    URI_WHITESPACE_CASES.push([
      `${name} before the : of a URI with ${kind}`,
      `postgresql://user${whitespace}:${value}@localhost/db`,
      secret,
    ])
    URI_WHITESPACE_CASES.push([
      `${name} after the : of a URI with ${kind}`,
      `postgresql://:${whitespace}${value}@localhost/db`,
      secret,
    ])
  }
}

test.each(URI_WHITESPACE_CASES)('%s is redacted whole', (_case, uri, secret) => {
  const sanitized = sanitizeProbeOutput(uri)
  expect(sanitized).not.toContain(secret)
  expect(sanitized).toBe('postgresql://<redacted>@localhost/db')
})

// A URI-like text whose user part holds a space is not a URI credential, and
// redacting it would take the diagnostic apart.
test('a URI-like text that is not a credential is left alone', () => {
  const text = 'see https://example.com and note: retry later'
  expect(sanitizeProbeOutput(text)).toBe(text)
})

// A connection URI may carry no user, only a password.
test('a connection URI with an empty user is redacted', () => {
  const sanitized = sanitizeProbeOutput('postgresql://:hunter2@localhost/db')
  expect(sanitized).not.toContain('hunter2')
  expect(sanitized).toBe('postgresql://<redacted>@localhost/db')
})

// The redaction is one pass over the text: a long plain token may not cost a
// pass per position, and the excerpt is still cut to the limit.
test('a long plain token is read once and the excerpt is still bounded', () => {
  const token = 'z'.repeat(1_000_000)
  const startedAt = performance.now()
  const sanitized = sanitizeProbeOutput(token)
  const elapsedMs = performance.now() - startedAt
  expect(sanitized).toHaveLength(PROBE_EXCERPT_LIMIT)
  expect(sanitized).toBe(token.slice(0, PROBE_EXCERPT_LIMIT))
  expect(elapsedMs).toBeLessThan(10_000)
})

// A long run of hexadecimal characters is an opaque token and is redacted
// whole, so it cannot reach the excerpt in pieces either.
test('a long opaque token is redacted whole', () => {
  const sanitized = sanitizeProbeOutput('a'.repeat(1_000))
  expect(sanitized).toBe('<redacted>')
})

// A secret that is cut by the excerpt limit is redacted first, so the cut can
// never split it into a part that is kept.
test('a secret longer than the excerpt is redacted before the cut', () => {
  const secret = `password=${'b'.repeat(1_000)}`
  const sanitized = sanitizeProbeOutput(secret)
  expect(sanitized).not.toContain('bbbb')
  expect(sanitized).toBe('password=<redacted>')
})

test('a message that only names a credential is not redacted', () => {
  const message =
    'psql: error: FATAL:  password authentication failed for user "control_plane_admin"'
  expect(sanitizeProbeOutput(message)).toBe(message)
})

test('a probe that timed out is a service that is not ready, and a missing executable is not', () => {
  expect(isProbeTimeout({ code: 'ETIMEDOUT' })).toBe(true)
  expect(isProbeTimeout({ code: 'ENOENT' })).toBe(false)
  expect(isProbeTimeout(undefined)).toBe(false)
})

test('the recovery ceiling the drill keeps is unchanged', () => {
  expect(POSTGRES_RECOVERY_CEILING_SECONDS).toBe(30)
})

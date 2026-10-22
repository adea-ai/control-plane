import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  describePostgresProbeFailure,
  isProbeTimeout,
  POSTGRES_RECOVERY_CEILING_SECONDS,
  PROBE_EXCERPT_LIMIT,
  sanitizeProbeOutput,
} from '../scripts/postgres-probe-diagnostics.mjs'

// The differential corpus. Every entry is a synthetic diagnostic string, the
// pure form that was handed to libpq's own parse-only interface, and the
// credentials libpq recognised in that form. The corpus was built against
// PQconninfoParse, which never opens a connection, so it says what libpq
// itself would treat as a password and what it would not.
const corpus = JSON.parse(
  readFileSync(
    new URL('./fixtures/postgres-probe-diagnostics.corpus.v1.json', import.meta.url),
    'utf8'
  )
)

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
// became `password=<redacted> words'`. A value that opens with a single
// quote has to be consumed whole, and a value whose quote is never closed has
// to take the rest of its line with it.
//
// libpq's own parser honours the single quote and no other: a double quote is
// an ordinary byte of a value, so `password="two words"` is the value `"two`
// and the text after the space is a separate token that libpq rejects. The
// redactor reads it the same way, and the corpus records what libpq makes of
// every form.
test('a quoted password leaves no tail behind', () => {
  const forms = ["password='two words'", "password='two\\' words'", "password='two words"]
  for (const form of forms) {
    const sanitized = sanitizeProbeOutput(form)
    expect(sanitized).not.toContain('two')
    expect(sanitized).not.toContain('words')
    expect(sanitized).toContain('<redacted>')
  }
})

// A double quote is an ordinary byte of a value, so the value runs to the
// next whitespace and what follows is a separate token, not the tail of a
// secret. libpq reads `password="two words"` as the value `"two` and rejects
// the rest of the string.
test('a double quote is an ordinary byte of the value', () => {
  expect(sanitizeProbeOutput('password="two words" dbname=postgres')).toBe(
    'password=<redacted> words" dbname=postgres'
  )
  expect(sanitizeProbeOutput('password="two words"')).toBe('password=<redacted> words"')
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

// A single-quoted value whose quote is never closed takes the rest of the
// source with it, and the separator whitespace does not change that. A
// double quote opens nothing, so the value runs to the next whitespace and
// what follows is a separate token, which is what libpq reads.
test('a value that starts after the separator whitespace is consumed whole', () => {
  expect(sanitizeProbeOutput("password= 'two words")).toBe('password=<redacted>')
  expect(sanitizeProbeOutput('password= "two words')).toBe('password=<redacted> words')
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

// The values the matrix pairs with each of those characters, and what libpq
// makes of them. The secret is the part of the value libpq reads as the
// credential and the tail is the text it leaves after it: a double quote
// opens nothing, so a value that starts with one runs to the next whitespace
// and the rest of it is a separate token.
const CONNINFO_WHITESPACE_VALUES = [
  ['an unquoted value', 'h0unter2', 'h0unter2', ''],
  ['a single quoted value', "'two w0rds'", 'two w0rds', ''],
  ['a double quoted value', '"two w0rds"', '"two', ' w0rds"'],
  ['an escaped value', 'two\\ w0rds', 'two w0rds', ''],
]

// A connection URI has no quote rule and no escape rule at all: the password
// is the raw text after the first `:` of the userinfo, so every one of those
// values is one password and none of them leaves a tail.
const URI_WHITESPACE_VALUES = [
  ['an unquoted value', 'h0unter2', 'h0unter2'],
  ['a single quoted value', "'two w0rds'", "'two w0rds'"],
  ['a double quoted value', '"two w0rds"', '"two w0rds"'],
  ['an escaped value', 'two\\ w0rds', 'two\\ w0rds'],
]

// The matrix: every ASCII whitespace character, before and after the `=`, with
// a quoted, an unquoted and an escaped value. The whitespace before the `=` is
// part of the text and is kept; the whitespace after it belongs to the value
// and is consumed with it.
const SEPARATOR_WHITESPACE_CASES = []
for (const [name, whitespace] of ASCII_WHITESPACE) {
  for (const [kind, value, secret, tail] of CONNINFO_WHITESPACE_VALUES) {
    SEPARATOR_WHITESPACE_CASES.push([
      `${name} before the = with ${kind}`,
      `password${whitespace}=${value} dbname=postgres`,
      secret,
      `password${whitespace}=<redacted>${tail} dbname=postgres`,
    ])
    SEPARATOR_WHITESPACE_CASES.push([
      `${name} after the = with ${kind}`,
      `password=${whitespace}${value} dbname=postgres`,
      secret,
      `password=<redacted>${tail} dbname=postgres`,
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
  for (const [kind, value, secret] of URI_WHITESPACE_VALUES) {
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

// A URI is not a connection string, and libpq parses the two differently. Its
// own URI parser reads the authority raw: the authority ends at the first `/`
// or `?`, the userinfo is the part of the authority before the first `@`, and
// the password is the raw text that follows the first `:` of the userinfo. A
// quote and a backslash have no meaning in a URI, and an authority with no `@`
// is a host and a port rather than a user and a password.
const URI_CREDENTIAL_CASES = [
  // a literal quote is an ordinary character of the password
  ['a quote at the start of the password', "postgresql://user:'abc'def@localhost/db", "'abc'def"],
  ['a double quote in the password', 'postgresql://user:a"b"c@localhost/db', 'a"b"c'],
  ['a quote in the middle of the password', "postgresql://user:ab'cd@localhost/db", "ab'cd"],
  // a backslash is an ordinary character of the password, and it does not
  // escape the `@` that ends the userinfo
  ['a backslash before the @', 'postgresql://user:pa\\@ss@localhost/db', 'pa\\'],
  ['a backslash in the middle of the password', 'postgresql://user:pa\\ss@localhost/db', 'pa\\ss'],
  // a percent-encoded `@` is not the `@` that ends the userinfo
  ['a percent-encoded @', 'postgresql://user:pa%40ss@localhost/db', 'pa%40ss'],
  ['a percent-encoded colon', 'postgresql://user:pa%3Ass@localhost/db', 'pa%3Ass'],
  ['a percent-encoded quote', 'postgresql://user:pa%27ss@localhost/db', 'pa%27ss'],
  // the ordinary forms
  ['an ordinary password', 'postgresql://user:pass@localhost/db', 'pass'],
  ['an ordinary password and an empty user', 'postgresql://:pass@localhost/db', 'pass'],
  ['an ordinary password with a port', 'postgresql://user:pass@localhost:5432/db', 'pass'],
  [
    'an ordinary password with a query',
    'postgresql://user:pass@localhost/db?sslmode=disable',
    'pass',
  ],
  ['a password that holds a space', 'postgresql://user:two words@localhost/db', 'two words'],
  // the boundaries libpq uses
  ['the first @ ends the userinfo', 'postgresql://user:pa@ss@localhost/db', 'pa'],
  [
    'the first : splits the user from the password',
    'postgresql://user:pa:ss@localhost/db',
    'pa:ss',
  ],
]

test.each(URI_CREDENTIAL_CASES)('%s is redacted whole', (_case, uri, secret) => {
  const sanitized = sanitizeProbeOutput(uri)
  expect(sanitized).not.toContain(secret)
  expect(sanitized).toContain('<redacted>')
})

// The URI grammar is libpq's, so the parts of a URI that hold no password are
// left as they are: a user and no password, and a host and a port.
test('the parts of a URI that hold no password are left alone', () => {
  expect(sanitizeProbeOutput('postgresql://user@localhost/db')).toBe(
    'postgresql://user@localhost/db'
  )
  expect(sanitizeProbeOutput('postgresql://localhost:5432/db')).toBe(
    'postgresql://localhost:5432/db'
  )
  expect(sanitizeProbeOutput('postgresql://localhost/db')).toBe('postgresql://localhost/db')
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

// The differential comparison. Every credential libpq recognises in the pure
// form of a corpus entry must not survive in the diagnostic text, and a form
// libpq recognises no credential in must come back unchanged, so the redactor
// neither publishes a secret nor takes a diagnostic apart.
test('the redaction matches what libpq recognises in the differential corpus', () => {
  const leaks = []
  const falseRedactions = []
  for (const entry of corpus.cases) {
    const sanitized = sanitizeProbeOutput(entry.text)
    for (const secret of entry.secrets) {
      if (sanitized.includes(secret)) leaks.push(`${entry.name}: ${secret}`)
    }
    if (entry.libpqRecognisedCredentials.length === 0 && !entry.libpqRejected) {
      if (sanitized !== entry.text) falseRedactions.push(entry.name)
    }
  }
  expect(leaks).toEqual([])
  expect(falseRedactions).toEqual([])
})

// The corpus itself, so a change to it is a change to what libpq was asked.
test('the differential corpus is the one that was built against libpq', () => {
  expect(corpus.cases.length).toBeGreaterThan(30)
  expect(corpus.oracle).toContain('PQconninfoParse')
  expect(corpus.cases.some((entry) => entry.libpqRejected)).toBe(true)
  expect(corpus.cases.some((entry) => entry.libpqRecognisedCredentials.length > 0)).toBe(true)
  expect(
    corpus.cases.some(
      (entry) => entry.libpqRecognisedCredentials.length === 0 && !entry.libpqRejected
    )
  ).toBe(true)
})

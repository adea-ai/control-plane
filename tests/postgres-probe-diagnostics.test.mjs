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

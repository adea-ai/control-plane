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
 * Redacts credentials from probe output and caps its length.
 *
 * The probe runs inside the compose service, so its output normally holds a
 * socket path and a database name. It can also hold a connection string, a
 * `PGPASSWORD` assignment, or a long opaque token, so those are redacted
 * before the text is kept.
 */
export function sanitizeProbeOutput(text, limit = PROBE_EXCERPT_LIMIT) {
  if (text === undefined || text === null) return ''
  const redacted = String(text)
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://<redacted>@')
    .replace(
      /\b(PGPASSWORD|password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*\S+/gi,
      '$1=<redacted>'
    )
    .replace(/\b[a-f0-9]{32,}\b/gi, '<redacted>')
  return redacted.trim().slice(0, limit)
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

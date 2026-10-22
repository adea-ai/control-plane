// Bounded retry for the npm bulk-advisory audit (`bun audit`).
//
// npm's bulk advisory endpoint (/-/npm/v1/security/advisories/bulk) answers 503
// under load. A 503 there is a transient service condition, not an audit
// result: the audit never ran, so no advisory was read and no verdict was
// produced. This helper retries that one confirmed condition, a bounded number
// of times, and treats every other outcome as a failure.
//
// What this helper never does:
//   - it never turns a failed audit into a pass (no cached pass, no
//     continue-on-error, no `|| true`);
//   - it never weakens the audit (the same `bun audit` invocation, with no
//     --audit-level, no --ignore and no registry override);
//   - it never retries a real audit finding: a vulnerability report is a
//     failure, not a transient condition;
//   - it never retries an outcome it does not understand: an unknown exit, a
//     signalled attempt, a stalled attempt or any exit code other than the
//     failed-audit code fails closed.
//
// The audit output is reproduced verbatim so the CI log keeps the evidence of
// what the audit reported.
//
// Observed bun 1.4.3 behaviour, measured against a local registry stub that
// answers 503 for the bulk advisory endpoint: bun posts to
// /-/npm/v1/security/advisories/bulk and reports
// `error: POST <registry>/-/npm/v1/security/advisories/bulk - 503` with exit
// code 1. A registry that also asks for a retry makes bun retry the endpoint
// internally for about six minutes and then report `... - Timeout` instead;
// that is not a confirmed HTTP 503, so it fails closed here.

import { spawn as spawnProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The npm bulk advisory endpoint that answers 503 under load. */
export const BULK_ADVISORY_PATH = '/-/npm/v1/security/advisories/bulk'

/** The only HTTP status this helper retries. */
export const TRANSIENT_STATUS = 503

/**
 * The exit code the pinned Bun uses for a failed audit. It is the only exit
 * code this helper understands, so it is the only one a transient condition may
 * carry.
 */
export const FAILED_AUDIT_EXIT_CODE = 1

/**
 * The pinned Bun diagnostic for the bulk advisory endpoint answering HTTP 503:
 * `error: POST <registry>/-/npm/v1/security/advisories/bulk - 503`.
 *
 * The diagnostic is matched whole: the request method, the bulk advisory
 * endpoint and the status are all required. A bare "503" somewhere in the
 * output, or the word "advisor" anywhere in it, is not this condition.
 */
export const BUN_BULK_ADVISORY_503 = new RegExp(
  `error: POST https?://\\S*${BULK_ADVISORY_PATH.replace('/', '\\/')} - ${TRANSIENT_STATUS}\\b`
)

/** Default number of audit attempts, including the first one. */
export const DEFAULT_ATTEMPTS = 2

/** Default pause between two attempts, in milliseconds. */
export const DEFAULT_DELAY_MS = 5_000

/**
 * Default per-attempt budget. It is larger than bun's own internal retry of
 * the advisory endpoint (about six minutes, measured) so a transient outage
 * that bun can still recover from is not cut short by this helper.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 420_000

/**
 * Default grace window between the SIGTERM and the SIGKILL of an attempt that
 * ran out of budget.
 */
export const DEFAULT_TERM_GRACE_MS = 10_000

/** The successful audit verdict bun prints. */
const SUCCESS_MARKER = /no vulnerabilities found/i

/**
 * An audit that reported findings. The shapes below are the ones the pinned
 * Bun prints for a real report: a `N vulnerabilities (...)` summary and the
 * per-advisory `GHSA-` lines.
 */
const FINDINGS_MARKER =
  /(?:\b\d+\s+vulnerabilit(?:y|ies)\b)|(?:\b\d+\s+advisor(?:y|ies)\s*\()|(?:github\.com\/advisories\/GHSA-)/i

/**
 * Classify one audit attempt.
 *
 * Findings are recognised before any success verdict, so an output that
 * carries both is a finding and never a pass.
 *
 * @param {object} attempt
 * @param {number | null} attempt.exitCode the audit process exit code, or null when it was killed
 * @param {string} attempt.output the combined stdout and stderr of the attempt
 * @param {boolean} [attempt.timedOut] whether the attempt exceeded its budget
 * @param {boolean} [attempt.signalled] whether the attempt was ended by a signal
 * @returns {{ kind: 'success' | 'findings' | 'transient-bulk-advisory-503' | 'failure', exitCode: number | null }}
 */
export function classifyAuditAttempt(attempt) {
  const output = attempt.output ?? ''
  const exitCode = attempt.exitCode ?? null
  if (attempt.timedOut) {
    // A stalled attempt is not a confirmed 503: it proves nothing about the
    // advisory service, so it is not retried as one.
    return { kind: 'failure', exitCode }
  }
  if (attempt.signalled || exitCode === null) {
    // An unknown or signalled outcome is not understood, so it fails closed.
    return { kind: 'failure', exitCode }
  }
  if (FINDINGS_MARKER.test(output)) {
    // A reported finding is a real result of the audit, never a transient one,
    // and it takes precedence over any success substring in the same output.
    return { kind: 'findings', exitCode }
  }
  if (BUN_BULK_ADVISORY_503.test(output)) {
    // The pinned bulk advisory diagnostic, carried by the failed-audit exit
    // code this helper understands. Any other exit code with the same
    // diagnostic is not understood and fails closed.
    if (exitCode === FAILED_AUDIT_EXIT_CODE) {
      return { kind: 'transient-bulk-advisory-503', exitCode }
    }
    return { kind: 'failure', exitCode }
  }
  if (exitCode === 0) {
    // A zero exit is a pass only with the success verdict.
    return SUCCESS_MARKER.test(output)
      ? { kind: 'success', exitCode }
      : { kind: 'failure', exitCode }
  }
  return { kind: 'failure', exitCode }
}

/**
 * Run the audit with a bounded retry for the one confirmed transient condition.
 *
 * @param {object} options
 * @param {(attempt: number) => Promise<{ exitCode: number | null, output: string, timedOut?: boolean, signalled?: boolean }>} options.runAudit
 *   runs one audit attempt; injected so the policy is testable without a registry
 * @param {number} [options.attempts] total attempts, including the first
 * @param {number} [options.delayMs] pause between attempts
 * @param {(ms: number) => Promise<void>} [options.sleep] pause implementation
 * @param {(message: string) => void} [options.log] progress reporting
 * @returns {Promise<{ kind: string, exitCode: number | null, attempts: object[] }>}
 */
export async function runAuditWithBoundedRetry(options) {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DEFAULT_ATTEMPTS))
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? DEFAULT_DELAY_MS))
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})
  const recorded = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await options.runAudit(attempt)
    const outcome = classifyAuditAttempt(result)
    recorded.push({ attempt, ...outcome, output: result.output })
    if (outcome.kind === 'success')
      return { kind: 'success', exitCode: outcome.exitCode, attempts: recorded }
    if (outcome.kind !== 'transient-bulk-advisory-503') {
      return { kind: outcome.kind, exitCode: outcome.exitCode, attempts: recorded }
    }
    log(
      `npm bulk advisory endpoint answered HTTP ${TRANSIENT_STATUS} (attempt ${attempt} of ${attempts}); the audit produced no verdict`
    )
    if (attempt < attempts) await sleep(delayMs)
  }
  // The condition persisted across every bounded attempt: the audit never ran.
  return { kind: 'failure', exitCode: recorded.at(-1)?.exitCode ?? null, attempts: recorded }
}

/**
 * Run one real `bun audit` attempt with a bounded budget.
 *
 * The invocation is exactly `bun audit`: no flag weakens the audit and no
 * registry override redirects it.
 *
 * When the attempt runs out of budget the owned child is ended with a bounded
 * escalation: SIGTERM, then SIGKILL after the grace window. Only that child
 * is signalled - its own descendants are left to it - and the attempt is
 * resolved only after the child's exit and cleanup have been observed.
 */
export async function runRealAuditAttempt({
  cwd,
  timeoutMs,
  termGraceMs = DEFAULT_TERM_GRACE_MS,
  spawn = spawnProcess,
}) {
  const child = spawn('bun', ['audit'], { cwd, env: process.env })
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk
  })
  const result = await new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let killTimer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(budgetTimer)
      clearTimeout(killTimer)
      resolve(value)
    }
    const budgetTimer = setTimeout(() => {
      timedOut = true
      // Bounded escalation, and only for the child this helper owns.
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, termGraceMs)
    }, timeoutMs)
    child.on('error', (error) => {
      finish({ exitCode: null, output: `${output}${error.message}` })
    })
    child.on('close', (code, signal) => {
      // The attempt resolves on the child's exit, so its cleanup is observed
      // before the next attempt can start.
      finish({ exitCode: code, output, timedOut, signalled: signal !== null })
    })
  })
  return result
}

/**
 * The command line entry point: run `bun audit`, retry only the confirmed
 * transient bulk-advisory 503, and fail with the audit's own exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  runAudit = undefined,
  write = (text) => process.stdout.write(text)
) {
  const attempts = readNumber(argv, '--attempts', DEFAULT_ATTEMPTS)
  const delayMs = readNumber(argv, '--delay-ms', DEFAULT_DELAY_MS)
  const timeoutMs = readNumber(argv, '--timeout-ms', DEFAULT_ATTEMPT_TIMEOUT_MS)
  const result = await runAuditWithBoundedRetry({
    attempts,
    delayMs,
    log: (message) => write(`${message}\n`),
    runAudit:
      runAudit ??
      (() =>
        runRealAuditAttempt({
          // The workflow step runs at the checkout root, which is where the
          // lockfile the audit reads lives.
          cwd: process.cwd(),
          timeoutMs,
        })),
  })
  for (const attempt of result.attempts) {
    if (attempt.output.length > 0) write(attempt.output)
    if (!attempt.output.endsWith('\n')) write('\n')
  }
  if (result.kind === 'success') return 0
  // A failed audit keeps its own exit code; a killed or absent one is a
  // failure of this step as well.
  return result.exitCode && result.exitCode !== 0 ? result.exitCode : 1
}

function readNumber(argv, flag, fallback) {
  const index = argv.indexOf(flag)
  if (index === -1) return fallback
  const value = Number(argv[index + 1])
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative number`)
  }
  return value
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}

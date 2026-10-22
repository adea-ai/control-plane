import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  cleanupOwnedTimeoutFixture,
  isProcessAlive,
  reapOwnedProcess,
  startOwnedTimeoutFixture,
} from './npm-audit-timeout.fixture.mjs'
import {
  BULK_ADVISORY_PATH,
  DEFAULT_ATTEMPTS,
  FAILED_AUDIT_EXIT_CODE,
  auditErrorMessages,
  classifyAuditAttempt,
  isPinnedBulkAdvisory503,
  main,
  runAuditWithBoundedRetry,
  runRealAuditAttempt,
} from './npm-audit-bounded-retry.mjs'

const SUCCESS_OUTPUT =
  'bun audit v1.4.3 (c6da4a4d3)\n\nNo vulnerabilities found (checked 533 packages) [302.00ms]\n'
const FINDINGS_OUTPUT = `bun audit v1.4.3 (c6da4a4d3)

lodash@4.17.15
  (direct dependency)
  high: Command Injection in lodash (<4.17.21) - https://github.com/advisories/GHSA-35jh-r3h4-6jhm
  moderate: Prototype Pollution in lodash (>=4.0.0 <4.17.21) - https://github.com/advisories/GHSA-p6mc-m468-83gw

6 vulnerabilities (3 high, 3 moderate)

  bun audit fix           upgrade the vulnerable packages within their ranges
`
const TRANSIENT_OUTPUT = `bun audit v1.4.3 (c6da4a4d3)

error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503
`
const BUN_TIMEOUT_OUTPUT = `bun audit v1.4.3 (c6da4a4d3)

error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - Timeout
`
const BARE_503_OUTPUT =
  'bun audit v1.4.3 (c6da4a4d3)\n\nerror: request failed, status 503 Service Unavailable\n'
const ADVISOR_TOKEN_OUTPUT =
  'bun audit v1.4.3 (c6da4a4d3)\n\nerror: the advisory service is unavailable: 503\n'
const PINNED_503_PLUS_OTHER_ERROR = `bun audit v1.4.3 (c6da4a4d3)

error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503
error: failed to read bun.lock: ENOENT
`
const PINNED_503_QUOTED = `bun audit v1.4.3 (c6da4a4d3)

error: wrapper failed: {"inner":"error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503"}
`
const PINNED_503_TWICE = `bun audit v1.4.3 (c6da4a4d3)

error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503
error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503
`
const PINNED_503_OTHER_PATH = `bun audit v1.4.3 (c6da4a4d3)

error: POST https://registry.npmjs.org/-/npm/v1/security/other/bulk - 503
`
const PINNED_503_WITH_QUERY = `bun audit v1.4.3 (c6da4a4d3)

error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH}?audit=1 - 503
`

function fakeRunner(outcomes) {
  const calls = []
  const runner = async (attempt) => {
    calls.push(attempt)
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]
    return typeof next === 'function' ? next() : next
  }
  return { runner, calls }
}

describe('the npm bulk advisory retry classification', () => {
  test('a successful audit is a success only with the success verdict', () => {
    expect(classifyAuditAttempt({ exitCode: 0, output: SUCCESS_OUTPUT })).toEqual({
      kind: 'success',
      exitCode: 0,
    })
    expect(classifyAuditAttempt({ exitCode: 0, output: 'bun audit v1.4.3\n' }).kind).toBe('failure')
  })

  test('a confirmed bulk advisory 503 on the failed-audit exit is the only transient condition', () => {
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: TRANSIENT_OUTPUT }).kind
    ).toBe('transient-bulk-advisory-503')
  })

  test('the transient condition needs the understood failed-audit exit', () => {
    // The pinned diagnostic with an exit code this helper does not understand.
    expect(classifyAuditAttempt({ exitCode: 0, output: TRANSIENT_OUTPUT }).kind).toBe('failure')
    expect(classifyAuditAttempt({ exitCode: 7, output: TRANSIENT_OUTPUT }).kind).toBe('failure')
  })

  test('a bare 503 is not the transient condition', () => {
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: BARE_503_OUTPUT }).kind
    ).toBe('failure')
  })

  test('an arbitrary advisor token is not the transient condition', () => {
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: ADVISOR_TOKEN_OUTPUT }).kind
    ).toBe('failure')
  })

  test("bun's own advisory timeout is not a confirmed 503", () => {
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: BUN_TIMEOUT_OUTPUT }).kind
    ).toBe('failure')
  })

  test('only the single pinned diagnostic is the transient condition', () => {
    // A second error beside it means the audit failed for another reason too.
    expect(
      classifyAuditAttempt({
        exitCode: FAILED_AUDIT_EXIT_CODE,
        output: PINNED_503_PLUS_OTHER_ERROR,
      }).kind
    ).toBe('failure')
    // The diagnostic quoted inside another message is not the audit's error.
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: PINNED_503_QUOTED }).kind
    ).toBe('failure')
    // Bun reports one failure per run; two identical lines are not that shape.
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: PINNED_503_TWICE }).kind
    ).toBe('failure')
    // A request that is not exactly the bulk advisory endpoint is not it.
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: PINNED_503_OTHER_PATH }).kind
    ).toBe('failure')
    // A query on the advisory request is not the pinned diagnostic.
    expect(
      classifyAuditAttempt({ exitCode: FAILED_AUDIT_EXIT_CODE, output: PINNED_503_WITH_QUERY }).kind
    ).toBe('failure')
  })

  test('an unknown or signalled outcome fails closed', () => {
    expect(classifyAuditAttempt({ exitCode: null, output: '' }).kind).toBe('failure')
    expect(classifyAuditAttempt({ exitCode: null, output: TRANSIENT_OUTPUT }).kind).toBe('failure')
    expect(classifyAuditAttempt({ exitCode: null, output: '', signalled: true }).kind).toBe(
      'failure'
    )
    expect(
      classifyAuditAttempt({ exitCode: null, output: TRANSIENT_OUTPUT, signalled: true }).kind
    ).toBe('failure')
    expect(classifyAuditAttempt({ exitCode: 1, output: '', timedOut: true }).kind).toBe('failure')
  })

  test('a finding takes precedence over a success substring in the same output', () => {
    const contradictory = `${SUCCESS_OUTPUT}\n${FINDINGS_OUTPUT}`
    expect(classifyAuditAttempt({ exitCode: 0, output: contradictory }).kind).toBe('findings')
    expect(classifyAuditAttempt({ exitCode: 1, output: contradictory }).kind).toBe('findings')
  })

  test('a reported finding is a result, never a transient condition', () => {
    expect(classifyAuditAttempt({ exitCode: 1, output: FINDINGS_OUTPUT })).toEqual({
      kind: 'findings',
      exitCode: 1,
    })
    // A finding together with the pinned 503 diagnostic is still a finding.
    const both = `${FINDINGS_OUTPUT}\nerror: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503\n`
    expect(classifyAuditAttempt({ exitCode: 1, output: both }).kind).toBe('findings')
  })
})

describe('the bounded retry policy', () => {
  test('a transient 503 is retried and a later success is a pass', async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: FAILED_AUDIT_EXIT_CODE, output: TRANSIENT_OUTPUT },
      { exitCode: 0, output: SUCCESS_OUTPUT },
    ])
    const result = await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    expect(result.kind).toBe('success')
    expect(calls).toEqual([1, 2])
  })

  test('a persistent 503 fails closed after the bounded attempts', async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: FAILED_AUDIT_EXIT_CODE, output: TRANSIENT_OUTPUT },
    ])
    const result = await runAuditWithBoundedRetry({
      runAudit: runner,
      attempts: 3,
      sleep: async () => {},
    })
    expect(result.kind).toBe('failure')
    expect(result.exitCode).toBe(FAILED_AUDIT_EXIT_CODE)
    expect(calls).toEqual([1, 2, 3])
    expect(result.attempts).toHaveLength(3)
  })

  test('the number of attempts is bounded and the pause is bounded', async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: FAILED_AUDIT_EXIT_CODE, output: TRANSIENT_OUTPUT },
    ])
    const pauses = []
    await runAuditWithBoundedRetry({
      runAudit: runner,
      attempts: 2,
      delayMs: 7,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    expect(calls).toHaveLength(2)
    expect(pauses).toEqual([7])
    expect(DEFAULT_ATTEMPTS).toBe(2)
  })

  test('findings and other failures are never retried', async () => {
    const findings = fakeRunner([{ exitCode: 1, output: FINDINGS_OUTPUT }])
    const findingResult = await runAuditWithBoundedRetry({
      runAudit: findings.runner,
      sleep: async () => {},
    })
    expect(findingResult.kind).toBe('findings')
    expect(findings.calls).toEqual([1])

    const other = fakeRunner([{ exitCode: 3, output: 'error: lockfile is out of date' }])
    const otherResult = await runAuditWithBoundedRetry({
      runAudit: other.runner,
      sleep: async () => {},
    })
    expect(otherResult.kind).toBe('failure')
    expect(otherResult.exitCode).toBe(3)
    expect(other.calls).toEqual([1])
  })

  test('a finding after a transient 503 is still a failure', async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: FAILED_AUDIT_EXIT_CODE, output: TRANSIENT_OUTPUT },
      { exitCode: 1, output: FINDINGS_OUTPUT },
    ])
    const result = await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    expect(result.kind).toBe('findings')
    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([1, 2])
  })

  test('no pass is cached: every invocation runs its own audit', async () => {
    const { runner, calls } = fakeRunner([{ exitCode: 0, output: SUCCESS_OUTPUT }])
    await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    expect(calls).toEqual([1, 1])
  })
})

describe('the audit invocation', () => {
  test('the real attempt runs exactly `bun audit`, with no flag and no registry override', async () => {
    const spawned = []
    const child = {
      stdout: { on() {} },
      stderr: { on() {} },
      on(event, handler) {
        if (event === 'close') setTimeout(() => handler(0, null), 0)
        return child
      },
      kill() {},
    }
    const spawnChild = (command, args, options) => {
      spawned.push({ command, args, options })
      return child
    }
    await runRealAuditAttempt({ cwd: '/tmp', timeoutMs: 1000, spawn: spawnChild })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe('bun')
    expect(spawned[0].args).toEqual(['audit'])
    expect(spawned[0].args).not.toContain('--audit-level')
    expect(spawned[0].args).not.toContain('--ignore')
  })

  test('the command line exit code is zero only for a real success', async () => {
    const quiet = () => {}
    const success = await main([], {}, async () => ({ exitCode: 0, output: SUCCESS_OUTPUT }), quiet)
    expect(success).toBe(0)
    const findings = await main(
      [],
      {},
      async () => ({ exitCode: 1, output: FINDINGS_OUTPUT }),
      quiet
    )
    expect(findings).toBe(1)
    const failure = await main([], {}, async () => ({ exitCode: 7, output: 'error: boom' }), quiet)
    expect(failure).toBe(7)
    const unknown = await main([], {}, async () => ({ exitCode: null, output: '' }), quiet)
    expect(unknown).toBe(1)
  })
})

describe('the bounded cleanup of an attempt that runs out of budget', () => {
  test('a TERM-resistant child is ended with a bounded escalation and only the owned child is cleaned up', async () => {
    const fixture = startOwnedTimeoutFixture()
    try {
      const started = Date.now()
      const result = await runRealAuditAttempt({
        cwd: fixture.directory,
        timeoutMs: 300,
        termGraceMs: 400,
        spawn: fixture.spawn,
      })
      const elapsed = Date.now() - started

      // The attempt is reported as a timeout, never as a transient condition.
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(null)
      expect(classifyAuditAttempt(result).kind).toBe('failure')

      // SIGTERM was delivered first, and the grace window was honoured before
      // the escalation.
      expect(readFileSync(fixture.signalLogPath, 'utf8')).toContain('TERM')
      expect(elapsed).toBeGreaterThanOrEqual(600)

      // The owned child is gone: the attempt resolved only after its exit.
      expect(isProcessAlive(fixture.ownedPid)).toBe(false)

      // Only the owned child was cleaned up: its own descendant was not
      // signalled. Its identity comes from the receipt the child published.
      const receipt = await fixture.readReceipt()
      expect(isProcessAlive(receipt.grandchildPid)).toBe(true)
    } finally {
      await cleanupOwnedTimeoutFixture(fixture)
    }
  })

  test('the attempt resolves when the owned child is reaped, even when a descendant holds the pipe', async () => {
    const fixture = startOwnedTimeoutFixture({ holdsPipe: true })
    try {
      const started = Date.now()
      const result = await runRealAuditAttempt({
        cwd: fixture.directory,
        timeoutMs: 300,
        termGraceMs: 300,
        drainMs: 250,
        spawn: fixture.spawn,
      })
      const elapsed = Date.now() - started

      // The attempt resolved on the reap, inside its own budget and drain,
      // instead of waiting for pipes a surviving descendant still holds.
      expect(result.timedOut).toBe(true)
      expect(elapsed).toBeLessThan(5_000)

      // Only the owned child was cleaned up.
      const receipt = await fixture.readReceipt()
      expect(isProcessAlive(receipt.grandchildPid)).toBe(true)
    } finally {
      await cleanupOwnedTimeoutFixture(fixture)
    }
  })

  test('a child that exits on SIGTERM is cleaned up without the escalation', async () => {
    const fixture = startOwnedTimeoutFixture({ exitsOnTerm: true })
    try {
      const result = await runRealAuditAttempt({
        cwd: fixture.directory,
        timeoutMs: 200,
        termGraceMs: 5_000,
        spawn: fixture.spawn,
      })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(0)
    } finally {
      await cleanupOwnedTimeoutFixture(fixture)
    }
  })

  test('a reap that cannot confirm the exit keeps the receipt and reports the failure', async () => {
    const fixture = startOwnedTimeoutFixture()
    fixture.spawn('bun', ['audit'], { cwd: fixture.directory, env: process.env })
    const receipt = await fixture.readReceipt()

    const outcome = await cleanupOwnedTimeoutFixture(fixture, { reap: async () => 'still-alive' })

    // The cleanup reports the failure and never claims success.
    expect(outcome.success).toBe(false)
    expect(outcome.problems).toContain('grandchild-still-alive')
    expect(outcome.problems).toContain('owned-child-still-alive')
    expect(outcome.receiptPresent).toBe(true)
    expect(outcome.directoryPreserved).toBe(true)
    expect(existsSync(fixture.receiptPath)).toBe(true)

    // A reap that refuses to touch the process is the same uncertainty: the
    // cleanup keeps the receipt and the directory and reports it.
    const refused = await cleanupOwnedTimeoutFixture(fixture, { reap: async () => 'not-ours' })
    expect(refused.success).toBe(false)
    expect(refused.problems).toContain('grandchild-not-ours')
    expect(refused.problems).toContain('owned-child-not-ours')
    expect(refused.receiptPresent).toBe(true)
    expect(refused.directoryPreserved).toBe(true)

    // The preserved receipt still names the process, so a later cleanup with
    // the real reap reclaims both the processes and the artifacts.
    const second = await cleanupOwnedTimeoutFixture(fixture)
    expect(second.success).toBe(true)
    expect(second.receiptPresent).toBe(false)
    expect(second.directoryPreserved).toBe(false)
    expect(isProcessAlive(receipt.grandchildPid)).toBe(false)
    expect(isProcessAlive(fixture.ownedPid)).toBe(false)
  })

  test('a missing receipt is not proof that no grandchild was started', async () => {
    const fixture = startOwnedTimeoutFixture()
    fixture.spawn('bun', ['audit'], { cwd: fixture.directory, env: process.env })
    const receipt = await fixture.readReceipt()
    rmSync(fixture.receiptPath, { force: true })

    const outcome = await cleanupOwnedTimeoutFixture(fixture)

    // The identity of a running process would be lost with the receipt, so the
    // cleanup fails closed and keeps the directory.
    expect(outcome.success).toBe(false)
    expect(outcome.problems).toContain('receipt-missing')
    expect(outcome.grandchild).toBe('unknown')
    expect(outcome.directoryPreserved).toBe(true)

    // The grandchild could not be identified from a receipt, so the test reaps
    // the process it recorded itself and then removes the preserved directory.
    expect(await reapOwnedProcess(receipt.grandchildPid, fixture.nonce)).not.toBe('still-alive')
    expect(await reapOwnedProcess(fixture.ownedPid, fixture.nonce)).not.toBe('still-alive')
    rmSync(fixture.directory, { recursive: true, force: true })
    expect(isProcessAlive(receipt.grandchildPid)).toBe(false)
    expect(isProcessAlive(fixture.ownedPid)).toBe(false)
  })

  test('the fixture reaps its owned processes and removes its receipts when an assertion fails', async () => {
    const fixture = startOwnedTimeoutFixture()
    // The fixture owns the child from the moment it starts, so the cleanup can
    // recover both identities without any success-path assertion.
    fixture.spawn('bun', ['audit'], { cwd: fixture.directory, env: process.env })
    const receipt = await fixture.readReceipt()
    let failure
    try {
      // A forced assertion failure, before any success-path assertion could
      // have recorded a process identity.
      expect(receipt.grandchildPid).toBe(-1)
    } catch (error) {
      failure = error
    }
    const outcome = await cleanupOwnedTimeoutFixture(fixture)

    // The cleanup ran on the failure path, not on the success path.
    expect(failure).toBeDefined()
    expect(outcome.success).toBe(true)
    expect(outcome.problems).toEqual([])
    expect(outcome.grandchild).toBe('reaped')
    expect(outcome.ownedChild).toBe('reaped')
    expect(outcome.receiptPresent).toBe(false)
    expect(outcome.directoryPreserved).toBe(false)

    // Neither owned process is left behind, and the receipt that named them
    // is gone only after they were reaped.
    expect(isProcessAlive(fixture.ownedPid)).toBe(false)
    expect(isProcessAlive(receipt.grandchildPid)).toBe(false)
    expect(existsSync(fixture.receiptPath)).toBe(false)
  })
})

describe('the M9 production readiness workflow keeps the audit mandatory', () => {
  const workflowPath = fileURLToPath(
    new URL('../../../.github/workflows/m9-production-readiness.yml', import.meta.url)
  )
  const workflow = readFileSync(workflowPath, 'utf8')

  test('the audit step runs the bounded-retry helper', () => {
    expect(workflow).toContain('npm-audit-bounded-retry')
  })

  test('no step continues on error and no step swallows a failure', () => {
    expect(workflow).not.toContain('continue-on-error')
    expect(workflow).not.toContain('|| true')
    expect(workflow).not.toContain('|| :')
  })

  test('the gate still requires every lane to have succeeded', () => {
    expect(workflow).toContain('test "$CORE_RESULT" = success')
    expect(workflow).toContain('test "$CONTAINERS_RESULT" = success')
    expect(workflow).toContain('test "$INTEGRATION_RESULT" = success')
  })

  test('the audit is not weakened and its endpoint is not redirected', () => {
    expect(workflow).not.toContain('--audit-level')
    expect(workflow).not.toContain('--ignore')
    expect(workflow).not.toContain('--registry')
  })
})

describe('the helper keeps its own guard rails', () => {
  test('the audit error messages are the ones the pinned Bun prints', () => {
    expect(auditErrorMessages(TRANSIENT_OUTPUT)).toEqual([
      `POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - 503`,
    ])
    expect(auditErrorMessages(SUCCESS_OUTPUT)).toEqual([])
    expect(auditErrorMessages(FINDINGS_OUTPUT)).toEqual([])
  })

  test('the pinned diagnostic is the whole diagnostic, not a substring', () => {
    expect(isPinnedBulkAdvisory503(TRANSIENT_OUTPUT)).toBe(true)
    expect(isPinnedBulkAdvisory503(PINNED_503_PLUS_OTHER_ERROR)).toBe(false)
    expect(isPinnedBulkAdvisory503(PINNED_503_QUOTED)).toBe(false)
    expect(isPinnedBulkAdvisory503(PINNED_503_TWICE)).toBe(false)
    expect(isPinnedBulkAdvisory503(PINNED_503_OTHER_PATH)).toBe(false)
    expect(isPinnedBulkAdvisory503(PINNED_503_WITH_QUERY)).toBe(false)
    expect(isPinnedBulkAdvisory503(BARE_503_OUTPUT)).toBe(false)
    expect(isPinnedBulkAdvisory503(ADVISOR_TOKEN_OUTPUT)).toBe(false)
    expect(isPinnedBulkAdvisory503(BUN_TIMEOUT_OUTPUT)).toBe(false)
  })

  test('the helper file exists where the workflow runs it from', () => {
    const helper = fileURLToPath(new URL('./npm-audit-bounded-retry.mjs', import.meta.url))
    expect(existsSync(helper)).toBe(true)
  })
})

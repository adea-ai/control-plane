import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BULK_ADVISORY_PATH,
  DEFAULT_ATTEMPTS,
  classifyAuditAttempt,
  main,
  runAuditWithBoundedRetry,
  runRealAuditAttempt,
} from './npm-audit-bounded-retry.mjs'

const SUCCESS_OUTPUT =
  'bun audit v1.4.2\n\nNo vulnerabilities found (checked 533 packages) [302.00ms]\n'
const FINDINGS_OUTPUT = `bun audit v1.4.2 (744846f84)

lodash@4.17.15
  (direct dependency)
  high: Command Injection in lodash (<4.17.21) - https://github.com/advisories/GHSA-35jh-r3h4-6jhm
  moderate: Prototype Pollution in lodash (>=4.0.0 <4.17.21) - https://github.com/advisories/GHSA-p6mc-m468-83gw

6 vulnerabilities (3 high, 3 moderate)

  bun audit fix           upgrade the vulnerable packages within their ranges
`
const TRANSIENT_OUTPUT = `bun audit v1.4.2\n\nerror: request to https://registry.npmjs.org${BULK_ADVISORY_PATH} failed, status 503 Service Unavailable\n`
const SPLIT_LINE_TRANSIENT_OUTPUT = `bun audit v1.4.2

error: failed to fetch https://registry.npmjs.org${BULK_ADVISORY_PATH}
  status: 503 Service Unavailable
`
const BUN_ADVISORY_TIMEOUT_OUTPUT = `bun audit v1.4.2 (744846f84)

error: POST https://registry.npmjs.org${BULK_ADVISORY_PATH} - Timeout
`
const UNRELATED_503_OUTPUT =
  'bun audit v1.4.2\n\nerror: request to https://registry.npmjs.org/some-package failed, status 503 Service Unavailable\n'

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
    // A zero exit without the verdict is not an audit pass.
    expect(classifyAuditAttempt({ exitCode: 0, output: 'bun audit v1.4.2\n' }).kind).toBe('failure')
  })

  test('a confirmed bulk advisory 503 is the only transient condition', () => {
    expect(classifyAuditAttempt({ exitCode: 1, output: TRANSIENT_OUTPUT }).kind).toBe(
      'transient-bulk-advisory-503'
    )
    // A 503 that is not the advisory service is not this condition.
    expect(classifyAuditAttempt({ exitCode: 1, output: UNRELATED_503_OUTPUT }).kind).toBe('failure')
    // Another status is not this condition either.
    expect(
      classifyAuditAttempt({
        exitCode: 1,
        output: `error: request to ${BULK_ADVISORY_PATH} failed, status 500 Internal Server Error`,
      }).kind
    ).toBe('failure')
    // A stalled attempt proves nothing about the advisory service.
    expect(classifyAuditAttempt({ exitCode: null, output: '', timedOut: true }).kind).toBe(
      'failure'
    )
  })

  test('a 503 reported over two lines is still the advisory condition', () => {
    expect(classifyAuditAttempt({ exitCode: 1, output: SPLIT_LINE_TRANSIENT_OUTPUT }).kind).toBe(
      'transient-bulk-advisory-503'
    )
  })

  test('a finding is never mistaken for a transient condition', () => {
    const output = `${FINDINGS_OUTPUT}error: request to ${BULK_ADVISORY_PATH} failed, status 503 Service Unavailable\n`
    expect(classifyAuditAttempt({ exitCode: 1, output }).kind).toBe('findings')
  })

  test("bun's own advisory timeout is not a confirmed 503 and is not retried", async () => {
    // Measured: bun retries the bulk advisory endpoint internally for about six
    // minutes and then reports a timeout. That is not a confirmed HTTP 503, so
    // the helper fails closed on it instead of retrying.
    expect(classifyAuditAttempt({ exitCode: 1, output: BUN_ADVISORY_TIMEOUT_OUTPUT }).kind).toBe(
      'failure'
    )
    const { runner, calls } = fakeRunner([{ exitCode: 1, output: BUN_ADVISORY_TIMEOUT_OUTPUT }])
    const result = await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    expect(result.kind).toBe('failure')
    expect(calls).toEqual([1])
  })

  test('a reported finding is a result, never a transient condition', () => {
    expect(classifyAuditAttempt({ exitCode: 1, output: FINDINGS_OUTPUT })).toEqual({
      kind: 'findings',
      exitCode: 1,
    })
  })
})

describe('the bounded retry policy', () => {
  test('a transient 503 is retried and a later success is a pass', async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 1, output: TRANSIENT_OUTPUT },
      { exitCode: 0, output: SUCCESS_OUTPUT },
    ])
    const result = await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    expect(result.kind).toBe('success')
    expect(calls).toEqual([1, 2])
  })

  test('a persistent 503 fails closed after the bounded attempts', async () => {
    const { runner, calls } = fakeRunner([{ exitCode: 1, output: TRANSIENT_OUTPUT }])
    const result = await runAuditWithBoundedRetry({
      runAudit: runner,
      attempts: 3,
      sleep: async () => {},
    })
    expect(result.kind).toBe('failure')
    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([1, 2, 3])
    expect(result.attempts).toHaveLength(3)
  })

  test('the number of attempts is bounded and the pause is bounded', async () => {
    const { runner, calls } = fakeRunner([{ exitCode: 1, output: TRANSIENT_OUTPUT }])
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

  test('a finding after a transient 503 is still a failure', async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 1, output: TRANSIENT_OUTPUT },
      { exitCode: 1, output: FINDINGS_OUTPUT },
    ])
    const result = await runAuditWithBoundedRetry({ runAudit: runner, sleep: async () => {} })
    expect(result.kind).toBe('findings')
    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([1, 2])
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
        if (event === 'close') setTimeout(() => handler(0), 0)
        return child
      },
      kill() {},
    }
    const spawn = (command, args, options) => {
      spawned.push({ command, args, options })
      return child
    }
    await runRealAuditAttempt({ cwd: '/tmp', timeoutMs: 1000, spawn })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe('bun')
    expect(spawned[0].args).toEqual(['audit'])
    // No --audit-level, no --ignore and no registry override: the audit is not
    // weakened and the advisory endpoint is not bypassed.
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

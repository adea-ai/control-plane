import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BULK_ADVISORY_PATH,
  DEFAULT_ATTEMPTS,
  FAILED_AUDIT_EXIT_CODE,
  classifyAuditAttempt,
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
    const directory = mkdtempSync(join(tmpdir(), 'npm-audit-timeout-'))
    const signalLog = join(directory, 'signals')
    const grandchildPidFile = join(directory, 'grandchild.pid')
    const script = join(directory, 'term-resistant.mjs')
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {
  appendFileSync(${JSON.stringify(signalLog)}, 'TERM\\n')
})
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid))
setInterval(() => {}, 1000)
`
    )
    let ownedPid
    let grandchildPid
    try {
      const started = Date.now()
      const result = await runRealAuditAttempt({
        cwd: directory,
        timeoutMs: 300,
        termGraceMs: 400,
        spawn: (command, args, options) => {
          const child = spawn(process.execPath, [script], {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          ownedPid = child.pid
          return child
        },
      })
      const elapsed = Date.now() - started

      // The attempt is reported as a timeout, never as a transient condition.
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(null)
      expect(classifyAuditAttempt(result).kind).toBe('failure')

      // SIGTERM was delivered first, and the grace window was honoured before
      // the escalation.
      expect(readFileSync(signalLog, 'utf8')).toContain('TERM')
      expect(elapsed).toBeGreaterThanOrEqual(600)

      // The owned child is gone: the attempt resolved only after its exit.
      expect(() => process.kill(ownedPid, 0)).toThrow()

      // Only the owned child was cleaned up: its own descendant was not
      // signalled.
      grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'))
      expect(() => process.kill(grandchildPid, 0)).not.toThrow()
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a child that exits on SIGTERM is cleaned up without the escalation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'npm-audit-term-'))
    const script = join(directory, 'term-responsive.mjs')
    writeFileSync(
      script,
      "process.on('SIGTERM', () => process.exit(0))\nsetInterval(() => {}, 1000)\n"
    )
    try {
      const result = await runRealAuditAttempt({
        cwd: directory,
        timeoutMs: 200,
        termGraceMs: 5_000,
        spawn: (command, args, options) =>
          spawn(process.execPath, [script], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
      })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
  test('the pinned diagnostic requires the method, the bulk advisory endpoint and the status', () => {
    expect(TRANSIENT_OUTPUT).toMatch(
      new RegExp(`error: POST https?://\\S*${BULK_ADVISORY_PATH.replace('/', '\\/')} - 503\\b`)
    )
    expect(BARE_503_OUTPUT).not.toMatch(
      new RegExp(`error: POST https?://\\S*${BULK_ADVISORY_PATH.replace('/', '\\/')} - 503\\b`)
    )
  })

  test('the helper file exists where the workflow runs it from', () => {
    const helper = fileURLToPath(new URL('./npm-audit-bounded-retry.mjs', import.meta.url))
    expect(existsSync(helper)).toBe(true)
  })
})

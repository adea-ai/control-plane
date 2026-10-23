import { spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  PostgresContextAuthoringCommandRepository,
  PostgresContextPackageRepository,
  PostgresEvaluationRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionValidationCommandRepository,
} from '../packages/database/src/index.ts'
import { createIsolatedPostgres } from '../packages/testing/src/postgres.ts'
import { contextAuthoringRecoveryFixture } from './context-authoring-recovery-fixture.mjs'
import { validationRecoveryFixture } from './validation-recovery-fixture.mjs'
import { evaluationRecoveryFixture } from './evaluation-recovery-fixture.mjs'
import {
  describePostgresProbeFailure,
  isProbeTimeout,
  POSTGRES_RECOVERY_CEILING_SECONDS,
} from './postgres-probe-diagnostics.mjs'

const expectedRunId = 'eval-run-disruption-drill'
const expectedDigest = `sha256:${'c'.repeat(64)}`
const maximumRecoverySeconds = 3_600

if (process.env.POSTGRES_DISRUPTION_ALLOWED !== 'true') {
  throw new Error('POSTGRES_DISRUPTION_NOT_AUTHORIZED')
}

function docker(arguments_, options = {}) {
  const result = spawnSync('docker', ['compose', ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: 90_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`docker compose exited with ${String(result.status)}`)
  return result.stdout ?? ''
}

/**
 * The state the compose service is in, for a failure that has to explain
 * itself. A service that is still starting, one that exited, and one that
 * never existed look the same in a bare timeout message.
 */
function readContainerState() {
  const result = spawnSync('docker', ['compose', 'ps', 'postgres'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10_000,
  })
  if (result.error) return `unavailable: ${result.error.code ?? result.error.name}`
  if (result.status !== 0) return `unavailable: exit ${String(result.status)}`
  return result.stdout ?? ''
}

async function waitForPostgres() {
  const deadline = Date.now() + POSTGRES_RECOVERY_CEILING_SECONDS * 1_000
  const startedAt = Date.now()
  let attempts = 0
  let lastStatus = null
  let lastStderr = ''
  let lastError = null
  let hardFailure = false
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    attempts += 1
    const result = spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '--username',
        'control_plane_admin',
        '--dbname',
        'postgres',
        '--tuples-only',
        '--no-align',
        '--command',
        'SELECT 1',
      ],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: Math.min(5000, remaining) }
    )
    if (result.error) {
      // A probe that timed out is a service that is not answering yet, so the
      // wait continues inside the recovery ceiling. Any other spawn failure is
      // a hard error and is reported with the same diagnostics.
      lastError = result.error
      if (!isProbeTimeout(result.error)) {
        hardFailure = true
        break
      }
    } else {
      lastError = null
      lastStatus = result.status
      lastStderr = result.stderr ?? ''
      if (result.status === 0 && result.stdout.trim() === '1') return
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
    )
  }
  const description = describePostgresProbeFailure({
    attempts,
    elapsedMs: Date.now() - startedAt,
    status: lastStatus,
    stderr: lastStderr,
    error: lastError,
    containerState: readContainerState(),
  })
  throw new Error(
    hardFailure
      ? `PostgreSQL readiness probe failed (${description})`
      : `PostgreSQL did not recover within ${POSTGRES_RECOVERY_CEILING_SECONDS} seconds (${description})`
  )
}

const database = await createIsolatedPostgres({ migrate: true })
const repository = new PostgresEvaluationRepository(database.application)
let serviceStopped = false

try {
  const observed = await evaluationRecoveryFixture(recoveryEvidence())
  await repository.saveRun(observed.run)
  observed.assertRecovered(await repository.getRun(observed.run.evalRunId))
  const validation = validationRecoveryFixture('disruption')
  await new PostgresContextPackageRepository(database.application).put(validation.contextPackage)
  const validationCommands = new PostgresExecutionValidationCommandRepository(database.application)
  const plans = new PostgresExecutionPlanRepository(database.application)
  await validationCommands.commit(validation.record, validation.plan)
  validation.assertRecovered(
    await validationCommands.get(validation.record.scope),
    await plans.get(validation.record.executionPlan)
  )
  const authoring = contextAuthoringRecoveryFixture('disruption')
  const commands = new PostgresContextAuthoringCommandRepository(database.application)
  const packages = new PostgresContextPackageRepository(database.application)
  await commands.commit(authoring.record, authoring.package_)
  authoring.assertRecovered(
    await commands.get(authoring.record.scope),
    await packages.get(authoring.record.contextPackage)
  )
  await repository.saveRun(recoveryEvidence())
  if ((await repository.getRun(expectedRunId))?.evalRunId !== expectedRunId) {
    throw new Error('DISRUPTION_MARKER_MISSING')
  }

  const disruptionStartedAt = Date.now()
  docker(['stop', '--timeout', '1', 'postgres'])
  serviceStopped = true
  await expectConnectionLoss(() => repository.getRun(expectedRunId))
  console.log('PostgreSQL connection-loss drill rejected access while the service was unavailable.')

  docker(['up', '-d', 'postgres'])
  await waitForPostgres()
  serviceStopped = false
  const restored = await repository.getRun(expectedRunId)
  observed.assertRecovered(await repository.getRun(observed.run.evalRunId))
  await repository.saveRun(observed.run)
  observed.assertRecovered(await repository.getRun(observed.run.evalRunId))
  validation.assertRecovered(
    await validationCommands.get(validation.record.scope),
    await plans.get(validation.record.executionPlan)
  )
  validation.assertRecovered(
    await validationCommands.commit(validation.record, validation.plan),
    await plans.get(validation.record.executionPlan)
  )
  authoring.assertRecovered(
    await commands.get(authoring.record.scope),
    await packages.get(authoring.record.contextPackage)
  )
  if (restored?.configuration.executionPlanDigest !== expectedDigest) {
    throw new Error('DISRUPTION_EVIDENCE_LOST')
  }
  const recoverySeconds = (Date.now() - disruptionStartedAt) / 1_000
  if (recoverySeconds > maximumRecoverySeconds) throw new Error('POSTGRES_RTO_EXCEEDED')
  console.log(
    'PostgreSQL service-restart drill preserved full observed evaluation receipts, evidence, authoring packages, and exact validation command/plan replay.'
  )
} finally {
  if (serviceStopped) {
    docker(['up', '-d', 'postgres'])
    await waitForPostgres()
  }
  await database.dispose()
}

async function expectConnectionLoss(operation) {
  try {
    await operation()
  } catch {
    return
  }
  throw new Error('POSTGRES_CONNECTION_LOSS_NOT_OBSERVED')
}

function recoveryEvidence() {
  const configuration = {
    executionPlanDigest: expectedDigest,
    profile: { id: 'profile', version: 'v1', digest: `sha256:${'1'.repeat(64)}` },
    skills: [],
    graph: { id: 'graph', version: 'v1', digest: `sha256:${'2'.repeat(64)}` },
    runtime: { id: 'runtime', version: 'v1', digest: `sha256:${'3'.repeat(64)}` },
    model: { id: 'model', version: 'v1', digest: `sha256:${'4'.repeat(64)}` },
    tools: [],
    policy: { id: 'policy', version: 'v1', digest: `sha256:${'5'.repeat(64)}` },
  }
  const dataset = { id: 'dataset', version: 'v1', digest: `sha256:${'6'.repeat(64)}` }
  return {
    evalRunId: expectedRunId,
    suite: {
      evalSuiteId: 'disruption-suite',
      version: 'v1',
      digest: `sha256:${'7'.repeat(64)}`,
      dataset,
      mode: 'offline',
      cases: [
        {
          evalCaseId: 'disruption-case',
          inputDigest: `sha256:${'8'.repeat(64)}`,
          scorers: [
            {
              metric: 'functional_correctness',
              direction: 'min',
              threshold: 1,
              required: true,
            },
          ],
        },
      ],
    },
    configuration,
    results: [
      {
        evalCaseId: 'disruption-case',
        dataset,
        configuration,
        metrics: { functional_correctness: 1 },
        failedRequiredMetrics: [],
        status: 'passed',
      },
    ],
    aggregateMetrics: { functional_correctness: 1 },
    status: 'passed',
    startedAt: '2026-08-25T12:00:00.000Z',
    completedAt: '2026-08-25T12:00:01.000Z',
  }
}

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  PostgresContextAuthoringCommandRepository,
  PostgresContextPackageRepository,
  PostgresEvaluationRepository,
} from '../packages/database/src/index.ts'
import { createIsolatedPostgres } from '../packages/testing/src/postgres.ts'
import { contextAuthoringRecoveryFixture } from './context-authoring-recovery-fixture.mjs'

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
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`docker compose exited with ${String(result.status)}`)
  return result.stdout ?? ''
}

async function waitForPostgres() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
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
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    )
    if (result.status === 0 && result.stdout.trim() === '1') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('PostgreSQL did not recover within 30 seconds')
}

const database = await createIsolatedPostgres({ migrate: true })
const repository = new PostgresEvaluationRepository(database.application)
let serviceStopped = false

try {
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
    'PostgreSQL service-restart failover drill preserved committed evidence and exact context authoring records/packages.'
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

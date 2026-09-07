import { spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  executionEvents,
  executions,
  PostgresContextAuthoringCommandRepository,
  PostgresContextPackageRepository,
  PostgresEvaluationRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionValidationCommandRepository,
  usageLedgerEntries,
} from '../packages/database/src/index.ts'
import { createIsolatedPostgres } from '../packages/testing/src/postgres.ts'
import { contextAuthoringRecoveryFixture } from './context-authoring-recovery-fixture.mjs'
import { validationRecoveryFixture } from './validation-recovery-fixture.mjs'
import { evaluationRecoveryFixture } from './evaluation-recovery-fixture.mjs'

const expectedRunId = 'eval-run-restore-drill'
const expectedDigest = `sha256:${'d'.repeat(64)}`
const executionDigest = `sha256:${'e'.repeat(64)}`
const eventPayloadHash = 'f'.repeat(64)
const usageIdempotencyKey = 'restore-drill:usage:1'

function dockerPostgres(arguments_, options = {}) {
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', ...arguments_], {
    cwd: process.cwd(),
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const diagnostic = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? '')
    process.stderr.write(diagnostic)
    throw new Error(`PostgreSQL restore drill command failed with status ${String(result.status)}`)
  }
  return result.stdout
}

const source = await createIsolatedPostgres({ migrate: true })
const target = await createIsolatedPostgres({ migrate: false })

try {
  const validation = validationRecoveryFixture('restore')
  await new PostgresExecutionValidationCommandRepository(source.application).commit(
    validation.record,
    validation.plan
  )
  const authoring = contextAuthoringRecoveryFixture('restore')
  await new PostgresContextAuthoringCommandRepository(source.application).commit(
    authoring.record,
    authoring.package_
  )
  const repository = new PostgresEvaluationRepository(source.application)
  const observed = await evaluationRecoveryFixture(recoveryEvidence())
  await repository.saveRun(observed.run)
  await repository.saveRun(recoveryEvidence())
  await source.application.insert(executions).values({
    executionId: 'exe_restore_drill',
    state: 'accepted',
    version: 1,
    workspaceId: 'wsp_restore_drill',
    projectId: 'prj_restore_drill',
    taskId: 'tsk_restore_drill',
    agentId: 'agt_restore_drill',
    requestId: 'req_restore_drill',
    executionPlanId: 'plan_restore_drill',
    executionPlanDigest: executionDigest,
    executionPlanSchemaVersion: 1,
    attemptCount: 0,
    acceptedAt: new Date('2026-08-25T12:00:00.000Z'),
    createdAt: new Date('2026-08-25T12:00:00.000Z'),
    updatedAt: new Date('2026-08-25T12:00:00.000Z'),
  })
  await source.application.insert(executionEvents).values({
    eventId: 'evt_restore_drill',
    executionId: 'exe_restore_drill',
    sequence: 1,
    eventType: 'execution.accepted',
    schemaVersion: 1,
    requestId: 'req_restore_drill',
    workspaceId: 'wsp_restore_drill',
    projectId: 'prj_restore_drill',
    taskId: 'tsk_restore_drill',
    agentId: 'agt_restore_drill',
    traceId: 'trc_restore_drill',
    payload: { state: 'accepted' },
    payloadBytes: 20,
    payloadHash: eventPayloadHash,
    occurredAt: new Date('2026-08-25T12:00:00.000Z'),
    recordedAt: new Date('2026-08-25T12:00:01.000Z'),
    retentionExpiresAt: new Date('2026-11-25T12:00:00.000Z'),
    publicationStatus: 'pending',
    publicationAttempts: 0,
    publicationVersion: 1,
  })
  await source.application.insert(usageLedgerEntries).values({
    entryId: 'usg_restore_drill',
    sequence: 1,
    workspaceId: 'wsp_restore_drill',
    executionId: 'exe_restore_drill',
    kind: 'model_usage',
    sourceId: 'restore-drill',
    idempotencyKey: usageIdempotencyKey,
    fundingSource: 'hq_managed',
    quantity: { unit: 'tokens', value: 42 },
    currency: 'USD',
    costMicrounits: 42,
    costExact: true,
    recordedAt: new Date('2026-08-25T12:00:02.000Z'),
  })
  const backup = dockerPostgres(
    [
      'pg_dump',
      '--username',
      'control_plane_admin',
      '--dbname',
      source.name,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
    ],
    { binary: true }
  )
  dockerPostgres(
    [
      'pg_restore',
      '--username',
      'control_plane_admin',
      '--role',
      'control_plane_migrator',
      '--dbname',
      target.name,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
    ],
    { binary: true, input: backup }
  )
  const restored = String(
    dockerPostgres([
      'psql',
      '--username',
      'control_plane_admin',
      '--dbname',
      target.name,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT
        evaluation_runs.eval_run_id || ':' ||
        (evaluation_runs.evidence->'configuration'->>'executionPlanDigest') || ':' ||
        executions.execution_plan_digest || ':' ||
        execution_events.payload_hash || ':' ||
        usage_ledger_entries.idempotency_key
      FROM executions
      JOIN execution_events USING (execution_id)
      JOIN usage_ledger_entries USING (execution_id)
      CROSS JOIN evaluation_runs
      WHERE executions.execution_id = 'exe_restore_drill'
        AND execution_events.event_id = 'evt_restore_drill'
        AND usage_ledger_entries.entry_id = 'usg_restore_drill'
        AND evaluation_runs.eval_run_id = 'eval-run-restore-drill'`,
    ])
  ).trim()
  if (
    restored !==
    `${expectedRunId}:${expectedDigest}:${executionDigest}:${eventPayloadHash}:${usageIdempotencyKey}`
  ) {
    throw new Error('PostgreSQL restore drill lost immutable recovery evidence')
  }
  // First verify raw restored evidence as admin; application bootstrap/replay follows below.
  observed.assertRecovered(
    JSON.parse(
      String(
        dockerPostgres([
          'psql',
          '--username',
          'control_plane_admin',
          '--dbname',
          target.name,
          '--tuples-only',
          '--no-align',
          '--command',
          "SELECT evidence FROM evaluation_runs WHERE eval_run_id = 'eval-run-restore-drill-observed'",
        ])
      ).trim()
    )
  )
  const restoredAuthoring = JSON.parse(
    String(
      dockerPostgres([
        'psql',
        '--username',
        'control_plane_admin',
        '--dbname',
        target.name,
        '--tuples-only',
        '--no-align',
        '--command',
        `SELECT json_build_object('record', c.record, 'package', p.context_package)
         FROM context_authoring_commands c
         JOIN context_packages p ON p.context_package_id = c.context_package_id
         WHERE c.command_key = '${authoring.commandKey}'`,
      ])
    ).trim()
  )
  authoring.assertRecovered(restoredAuthoring.record, restoredAuthoring.package)
  const restoredValidation = JSON.parse(
    String(
      dockerPostgres([
        'psql',
        '--username',
        'control_plane_admin',
        '--dbname',
        target.name,
        '--tuples-only',
        '--no-align',
        '--command',
        `SELECT json_build_object('record', c.record, 'plan', p.plan)
     FROM execution_validation_commands c
     JOIN execution_plans p ON p.execution_plan_id = c.execution_plan_id
     WHERE c.command_key = '${validation.commandKey}'`,
      ])
    ).trim()
  )
  validation.assertRecovered(restoredValidation.record, restoredValidation.plan)
  // No ACLs are imported. Prove the application cannot read until the existing
  // migration/bootstrap contract reapplies its narrowly scoped grants.
  const restoredEvaluations = new PostgresEvaluationRepository(target.application)
  let deniedBeforeBootstrap = false
  try {
    await restoredEvaluations.getRun(observed.run.evalRunId)
  } catch (error) {
    if ((error.cause ?? error).code !== '42501') throw error
    deniedBeforeBootstrap = true
  }
  if (!deniedBeforeBootstrap) throw new Error('RESTORE_APPLICATION_ACCESS_NOT_ISOLATED')
  await target.migrate()
  observed.assertRecovered(await restoredEvaluations.getRun(observed.run.evalRunId))
  await restoredEvaluations.saveRun(observed.run)
  observed.assertRecovered(await restoredEvaluations.getRun(observed.run.evalRunId))
  const restoredCommands = new PostgresContextAuthoringCommandRepository(target.application)
  const restoredPackages = new PostgresContextPackageRepository(target.application)
  authoring.assertRecovered(
    await restoredCommands.commit(authoring.record, authoring.package_),
    await restoredPackages.get(authoring.record.contextPackage)
  )
  const restoredValidations = new PostgresExecutionValidationCommandRepository(target.application)
  const restoredPlans = new PostgresExecutionPlanRepository(target.application)
  validation.assertRecovered(
    await restoredValidations.commit(validation.record, validation.plan),
    await restoredPlans.get(validation.record.executionPlan)
  )
  await restoredEvaluations.saveRun({ ...observed.run, evalRunId: 'eval-run-after-restore' })
  observed.assertRecovered({
    ...(await restoredEvaluations.getRun('eval-run-after-restore')),
    evalRunId: observed.run.evalRunId,
  })
  const [role] = await target.application.execute(
    "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, has_schema_privilege(current_user, 'public', 'CREATE') AS can_create FROM pg_roles WHERE rolname = current_user"
  )
  if (
    role.name !== 'control_plane_app' ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.can_create
  )
    throw new Error('RESTORE_APPLICATION_ROLE_ESCALATED')
  console.log(
    'PostgreSQL backup and restore drill preserved full evidence and restored application-role reads, immutable replay and new evaluation writes without DDL or role-administration privileges.'
  )
} finally {
  await Promise.allSettled([source.dispose(), target.dispose()])
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
      evalSuiteId: 'restore-suite',
      version: 'v1',
      digest: `sha256:${'7'.repeat(64)}`,
      dataset,
      mode: 'offline',
      cases: [
        {
          evalCaseId: 'restore-case',
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
        evalCaseId: 'restore-case',
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

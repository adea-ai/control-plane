import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadDatabaseCredentials } from '@control-plane/config'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const script = fileURLToPath(
  new URL('../../../scripts/admission-rollout-admin.mjs', import.meta.url)
)
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe.skipIf(!enabled)('PostgreSQL admission rollout operator CLI', () => {
  test(
    'checks authority, fresh audit, drain, and durable resume across operator processes',
    async () => {
      const credentials = {
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      }
      const isolated = await createIsolatedTestDatabase(credentials)
      try {
        await isolated.migrate()
        const run = (verb, profile) => {
          const url = new URL(credentials[profile].url)
          url.pathname = `/${isolated.name}`
          return spawnSync(
            process.execPath,
            [
              script,
              verb,
              '--host',
              url.hostname,
              '--port',
              url.port || '5432',
              '--database',
              isolated.name,
              ...(['pause', 'resume'].includes(verb) ? ['--confirm', verb] : []),
            ],
            {
              cwd: repositoryRoot,
              env: { ...process.env, DATABASE_MIGRATION_URL: url.href },
              encoding: 'utf8',
              timeout: 15_000,
              maxBuffer: 1_048_576,
            }
          )
        }
        const denied = run('pause', 'application')
        expect(denied.error).toBeUndefined()
        expect(denied.status).toBe(1)
        expect(denied.stdout).toBe('')
        expect(denied.stderr).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')

        const initial = run('status', 'migration')
        expect(initial.error).toBeUndefined()
        expect(initial.status).toBe(0)
        expect(JSON.parse(initial.stdout).state).toBe('open')

        const paused = run('pause', 'migration')
        expect(paused.error).toBeUndefined()
        expect(paused.status).toBe(0)
        const pause = JSON.parse(paused.stdout)
        expect(pause.state).toBe('paused')
        expect(pause.updatedBy).toBe(new URL(credentials.migration.url).username)

        const restarted = run('status', 'migration')
        expect(restarted.error).toBeUndefined()
        expect(restarted.status).toBe(0)
        expect(JSON.parse(restarted.stdout)).toEqual(pause)

        const deniedAudit = run('audit', 'application')
        expect(deniedAudit.error).toBeUndefined()
        expect(deniedAudit.status).toBe(1)
        expect(deniedAudit.stdout).toBe('')
        expect(deniedAudit.stderr).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')

        const audit = run('audit', 'migration')
        expect(audit.error).toBeUndefined()
        expect(audit.status).toBe(0)
        expect(JSON.parse(audit.stdout)).toMatchObject({ complete: true, canResume: true })

        const deniedResume = run('resume', 'application')
        expect(deniedResume.error).toBeUndefined()
        expect(deniedResume.status).toBe(1)
        expect(deniedResume.stdout).toBe('')
        expect(deniedResume.stderr).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')
        expect(JSON.parse(run('status', 'migration').stdout)).toEqual(pause)

        const resumed = run('resume', 'migration')
        expect(resumed.error).toBeUndefined()
        expect(resumed.status).toBe(0)
        const resume = JSON.parse(resumed.stdout)
        expect(resume.gate).toMatchObject({ state: 'open', revision: pause.revision + 1 })
        expect(resume.audit).toMatchObject({ complete: true, canResume: true })
        expect(JSON.parse(run('status', 'migration').stdout)).toEqual(resume.gate)

        // A real post-resume owner makes a previously clean audit stale. Resume
        // must re-audit rather than trusting that saved report or prior gate state.
        const plan = createExecutionPlanTestFixture()
        await new PostgresContextPackageRepository(isolated.application).put(
          contextPackageSerializationFixtures.futurePi
        )
        await new PostgresExecutionPlanRepository(isolated.application).put(plan)
        const lifecycle = new ExecutionLifecycleService(
          new PostgresExecutionRepository(isolated.application)
        )
        const owner = await lifecycle.createExecution({
          executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAH',
          correlation: plan.correlation,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          acceptedAt: plan.compiledAt,
        })
        expect(owner.state).toBe('accepted')
        const repaused = run('pause', 'migration')
        expect(repaused.error).toBeUndefined()
        expect(repaused.status).toBe(0)
        const deniedUnsafeAudit = run('audit', 'application')
        expect(deniedUnsafeAudit.error).toBeUndefined()
        expect(deniedUnsafeAudit.status).toBe(1)
        expect(deniedUnsafeAudit.stdout).toBe('')
        expect(deniedUnsafeAudit.stderr).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')

        const unsafeAudit = run('audit', 'migration')
        expect(unsafeAudit.error).toBeUndefined()
        expect(unsafeAudit.status).toBe(2)
        expect(JSON.parse(unsafeAudit.stdout)).toMatchObject({ complete: true, canResume: false })
        const unsafeResume = run('resume', 'migration')
        expect(unsafeResume.error).toBeUndefined()
        expect(unsafeResume.status).toBe(1)
        expect(unsafeResume.stdout).toBe('')
        expect(unsafeResume.stderr).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')
        expect(JSON.parse(run('status', 'migration').stdout)).toEqual(JSON.parse(repaused.stdout))

        // Existing work can drain while new intake remains paused; no funding or
        // accounting records are fabricated to make the terminal audit pass.
        const cancelling = await lifecycle.transitionExecution({
          executionId: owner.executionId,
          expectedVersion: owner.version,
          to: 'cancelling',
          transitionedAt: '2026-09-27T22:00:00.000Z',
        })
        await lifecycle.transitionExecution({
          executionId: owner.executionId,
          expectedVersion: cancelling.version,
          to: 'cancelled',
          transitionedAt: '2026-09-27T22:00:01.000Z',
        })
        const drainedResume = run('resume', 'migration')
        expect(drainedResume.error).toBeUndefined()
        expect(drainedResume.status).toBe(0)
        const drained = JSON.parse(drainedResume.stdout)
        expect(drained.gate.state).toBe('open')
        expect(drained.audit).toMatchObject({ complete: true, canResume: true })
        expect(JSON.parse(run('status', 'migration').stdout)).toEqual(drained.gate)
      } finally {
        await isolated.dispose()
      }
    },
    integrationTestTimeout(60_000)
  )
})

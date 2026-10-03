import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import {
  PostgresContextPackageRepository,
  PostgresContextPackageRetention,
} from './context-package-repository.ts'
import {
  PostgresRetentionHoldRepository,
  retentionHoldDatabaseAuthority,
} from './retention-hold-repository.ts'
import { contextPackages } from './schema/context-packages.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const dayMs = 24 * 60 * 60 * 1000
const retainMs = 90 * dayMs
// Keep the simulated retention instant valid for physical apply even as the
// test suite moves forward in time; retention-apply deliberately rejects a
// future --now value.
const observedAt = new Date(Date.now() - retainMs - dayMs)
const projectScope = (package_) => ({
  kind: 'project',
  workspaceId: package_.projectState.workspaceId,
  projectId: package_.projectState.projectId,
})

describe.skipIf(!enabled)('PostgreSQL retention-hold operator CLI', () => {
  test(
    'verified hold administration and class sweep enforce target, scope, and hold lifecycle',
    async () => {
      let isolated
      let directory
      let testError
      try {
        const credentials = {
          administration: loadDatabaseCredentials(process.env, 'administration'),
          application: loadDatabaseCredentials(process.env, 'application'),
          migration: loadDatabaseCredentials(process.env, 'migration'),
        }
        isolated = await createIsolatedTestDatabase(credentials)
        await isolated.migrate()

        directory = await mkdtemp(join(tmpdir(), 'retention-hold-operator-'))
        const adminScript = fileURLToPath(
          new URL('../../../scripts/retention-hold-admin.mjs', import.meta.url)
        )
        const applyScript = fileURLToPath(
          new URL('../../../scripts/retention-apply.mjs', import.meta.url)
        )
        const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
        const baseUrl = new URL(credentials.application.url)
        const isolatedUrl = new URL(credentials.application.url)
        isolatedUrl.pathname = `/${isolated.name}`
        const environment = {
          ...process.env,
          DATABASE_URL: isolatedUrl.href,
          CONTROL_PLANE_RETENTION_HOLD_TEST_DIAGNOSTICS: '1',
        }
        const session = {
          actorPrincipalRef: `operator:os-user:${encodeURIComponent(userInfo().username)}`,
          authorityRef: await retentionHoldDatabaseAuthority(isolated.application),
        }
        expect(session.authorityRef).toBe(
          `authority:postgres:role:${encodeURIComponent(baseUrl.username)}`
        )

        const package_ = contextPackageSerializationFixtures.futureAcp
        const contexts = new PostgresContextPackageRepository(isolated.application)
        await contexts.put(package_)
        const retention = new PostgresContextPackageRetention(isolated.application)
        const firstPass = await retention.deleteEligibleContextPackages(observedAt, {
          policyRetainMs: retainMs,
          dryRun: false,
        })
        expect(firstPass.deleted).toBe(0)
        const [clock] = await isolated.application
          .select({ unreferencedSince: contextPackages.unreferencedSince })
          .from(contextPackages)
        expect(clock?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

        const holdId = randomUUID()
        const requestPath = join(directory, 'request.json')
        const policyPath = join(directory, 'policy.json')
        const journalPath = join(directory, 'retention-journal.jsonl')
        const host = baseUrl.hostname
        const projectGrant = {
          actorPrincipalRef: session.actorPrincipalRef,
          authorityRef: session.authorityRef,
          classId: 'context-packages',
          scope: projectScope(package_),
          actions: ['create', 'release', 'sweep'],
        }
        const policyDocument = (grants, database = isolated.name) => ({
          schemaVersion: 1,
          target: {
            backend: 'postgres',
            database,
            host,
            port: baseUrl.port === '' ? 5432 : Number(baseUrl.port),
          },
          policy: {
            'context-packages': {
              owner: 'workspace-owner',
              scopes: ['class', 'workspace', 'project'],
              reasonCodes: ['legal-case'],
            },
          },
          grants,
        })
        const writePolicy = async (document) => {
          await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 })
          await chmod(policyPath, 0o600)
        }
        const runCli = (script, args) =>
          spawnSync(process.execPath, [script, ...args], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            timeout: 15_000,
            env: environment,
            maxBuffer: 1024 * 1024,
          })
        const writeRequest = async (request) =>
          writeFile(requestPath, JSON.stringify(request), { mode: 0o600 })
        const runAdmin = (request) => {
          return writeRequest(request).then(() =>
            runCli(adminScript, [
              '--backend',
              'postgres',
              '--database',
              isolated.name,
              '--host',
              host,
              '--hold-policy',
              policyPath,
              '--input',
              requestPath,
            ])
          )
        }
        const holdRepository = new PostgresRetentionHoldRepository(isolated.application, {
          'context-packages': {
            owner: 'workspace-owner',
            scopes: ['class', 'workspace', 'project'],
            reasonCodes: ['legal-case'],
          },
        })
        const holdRequest = {
          operation: 'create',
          holdId,
          classId: 'context-packages',
          scope: projectScope(package_),
          reasonCode: 'legal-case',
          actorPrincipalRef: session.actorPrincipalRef,
          authorityRef: session.authorityRef,
        }

        await writePolicy(policyDocument([projectGrant]))
        for (const spoofed of [
          { ...holdRequest, actorPrincipalRef: 'operator:os-user:forged' },
          { ...holdRequest, authorityRef: 'authority:postgres:role:forged' },
        ]) {
          const rejected = await runAdmin(spoofed)
          expect(rejected.status).toBe(1)
          expect(rejected.stdout).toBe('')
          expect(rejected.stderr).toBe(
            'RETENTION_HOLD_ADMIN_FAILED RETENTION_HOLD_ACTOR_MISMATCH_AUTHORIZATION\n'
          )
          expect(await holdRepository.get(holdId)).toBeUndefined()
        }

        const created = await runAdmin(holdRequest)
        expect(created.stderr).toBe('')
        expect(created.status).toBe(0)
        expect(JSON.parse(created.stdout)).toEqual({
          status: 'applied',
          operation: 'create',
          holdId,
          revision: 0,
        })
        expect(await holdRepository.get(holdId)).toMatchObject({ holdId, revision: 0 })

        const expiredAt = new Date(observedAt.getTime() + retainMs + 1)
        const runApply = () =>
          runCli(applyScript, [
            '--backend',
            'postgres',
            '--database',
            isolated.name,
            '--host',
            host,
            '--class',
            'context-packages',
            '--apply',
            '--confirm',
            'context-packages',
            '--hold-policy',
            policyPath,
            '--journal',
            journalPath,
            '--now',
            expiredAt.toISOString(),
          ])

        // A project grant is not permission for the repository's whole-class pass.
        const deniedClassSweep = runApply()
        expect(deniedClassSweep.status).toBe(1)
        expect(deniedClassSweep.stdout).toBe('')
        expect(deniedClassSweep.stderr).toBe('RETENTION_APPLY_FAILED\n')
        expect(await holdRepository.get(holdId)).toMatchObject({ revision: 0 })

        const classSweepGrant = {
          ...projectGrant,
          scope: { kind: 'class' },
          actions: ['sweep'],
        }
        await writePolicy(policyDocument([projectGrant, classSweepGrant]))
        const heldSweep = runApply()
        expect(heldSweep.status).toBe(0)
        expect(heldSweep.stderr).toBe('')
        expect(JSON.parse(heldSweep.stdout)).toMatchObject({
          report: 'retention-apply',
          class: 'context-packages',
          backend: 'postgres',
          result: { deleted: 0, retainedByReason: { hold_recorded: 1 } },
        })
        await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await contexts.getById(package_.contextPackageId)).toBeDefined()

        const releaseRequest = {
          operation: 'release',
          holdId,
          requestId: randomUUID(),
          expectedRevision: 0,
          actorPrincipalRef: session.actorPrincipalRef,
          authorityRef: session.authorityRef,
        }
        await writePolicy(policyDocument([projectGrant], `${isolated.name}_wrong_target`))
        const mismatchedTarget = await runAdmin(releaseRequest)
        expect(mismatchedTarget.status).toBe(1)
        expect(mismatchedTarget.stdout).toBe('')
        expect(mismatchedTarget.stderr).toBe(
          'RETENTION_HOLD_ADMIN_FAILED POLICY_TARGET_MISMATCH_POLICY\n'
        )
        expect(await holdRepository.get(holdId)).toMatchObject({ revision: 0 })

        await writePolicy(policyDocument([projectGrant, classSweepGrant]))
        const released = await runAdmin(releaseRequest)
        expect(released.status).toBe(0)
        expect(JSON.parse(released.stdout)).toEqual({
          status: 'applied',
          operation: 'release',
          holdId,
          revision: 1,
        })
        const releasedHold = await holdRepository.get(holdId)
        expect(Date.parse(releasedHold.release.releasedAt)).toBeGreaterThanOrEqual(
          expiredAt.getTime()
        )
        expect(Date.parse(releasedHold.release.releasedAt)).toBeLessThanOrEqual(Date.now())
        const replayed = await runAdmin(releaseRequest)
        expect(replayed.status).toBe(0)
        expect(JSON.parse(replayed.stdout)).toEqual({
          status: 'replayed',
          operation: 'release',
          holdId,
          revision: 1,
        })

        const deleted = runApply()
        expect(deleted.status).toBe(0)
        expect(deleted.stderr).toBe('')
        expect(JSON.parse(deleted.stdout)).toMatchObject({
          report: 'retention-apply',
          result: { deleted: 1 },
        })
        const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n')
        expect(journalLines).toHaveLength(1)
        expect(JSON.parse(journalLines[0])).toMatchObject({
          backend: 'postgres',
          classId: 'context-packages',
          operations: [
            { kind: 'postgres.deleteContextPackage', contextPackageId: package_.contextPackageId },
          ],
        })
        expect(await contexts.getById(package_.contextPackageId)).toBeUndefined()
      } catch (error) {
        testError = error
      }

      const cleanup = await Promise.allSettled([
        ...(directory === undefined ? [] : [rm(directory, { recursive: true })]),
        ...(isolated === undefined ? [] : [isolated.dispose()]),
      ])
      const cleanupErrors = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (testError !== undefined && cleanupErrors.length > 0)
        throw new AggregateError(
          [testError, ...cleanupErrors],
          'RETENTION_HOLD_CLI_TEST_AND_CLEANUP_FAILED'
        )
      if (testError !== undefined) throw testError
      if (cleanupErrors.length > 0)
        throw new AggregateError(cleanupErrors, 'RETENTION_HOLD_CLI_CLEANUP_FAILED')
    },
    integrationTestTimeout(90_000)
  )
})

import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { eq } from 'drizzle-orm'
import { ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { VersionedCatalog } from '@control-plane/domain'
import { ExecutionPlanCompiler, deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresCatalogRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresDurableUsageStore,
  commandInbox,
  executions,
  executionPlans,
  usageBudgetStates,
  usageLedgerEntries,
  usageOperationReceipts,
} from '@control-plane/database'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { withIsolatedPostgres } from '@control-plane/testing/postgres'
import { createManagedCloudControlApiComposition } from './cloud-composition.ts'
import { createControlApiApplication } from './application.ts'

const id = (prefix, tail = 'G') => `${prefix}_01JABCDEF0123456789ABCDEF${tail}`

async function seed(database) {
  const inputs = createExecutionPlanTestFixtureInputs()
  inputs.profile.definition.skills = []
  inputs.skills = []
  const repository = new PostgresCatalogRepository(database)
  const catalog = new VersionedCatalog(repository, repository)
  await catalog.createAgentProfile({
    profileId: inputs.profile.profileId,
    displayName: 'Budget admission fixture',
    ownership: { scope: 'system' },
    createdAt: inputs.profile.createdAt,
  })
  const draft = await catalog.createAgentProfileDraft({
    profileId: inputs.profile.profileId,
    profileVersionId: inputs.profile.profileVersionId,
    version: inputs.profile.version,
    definition: inputs.profile.definition,
    createdAt: inputs.profile.createdAt,
  })
  inputs.profile = await catalog.publishAgentProfileVersion({
    profileVersionId: draft.profileVersionId,
    expectedRevision: draft.revision,
    publishedAt: new Date().toISOString(),
  })
  await new PostgresContextPackageRepository(database).put(
    contextPackageSerializationFixtures.futurePi
  )
  const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  await new PostgresExecutionPlanRepository(database).put(plan)
  return plan
}

async function snapshot(database) {
  return Promise.all(
    [commandInbox, executions, usageBudgetStates, usageLedgerEntries, usageOperationReceipts].map(
      (table) => database.select().from(table)
    )
  )
}

test.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'signed Cloud admission allocates from the stored plan, rejects exhausted children before dispatch, and verifies cold replay',
  async () => {
    await withIsolatedPostgres(
      async (isolated) => {
        const hosts = []
        let disposalFailures = []
        let submissions = 0
        const ingress = createServer((request, response) => {
          submissions += 1
          request.resume()
          response.writeHead(202, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ status: 'Accepted', invocationId: 'inv_budgetAdmission' }))
        })
        try {
          await isolated.migrate()
          const plan = await seed(isolated.application)
          await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve))
          console.info(`M11 budget admission fixture ingress: 127.0.0.1:${ingress.address().port}`)
          const url = new URL(process.env.DATABASE_URL)
          url.pathname = `/${isolated.name}`
          const { privateKey, publicKey } = generateKeyPairSync('ed25519')
          const authentication = {
            audience: 'control-plane',
            issuer: 'https://budget-admission.test',
            trustedKeys: [
              { keyId: 'budget-key', publicKey: publicKey.export({ format: 'jwk' }).x },
            ],
            revokedCredentialIds: [],
          }
          const configuration = {
            service: 'control-api',
            database: { role: 'application', url: url.toString() },
            serviceAuthentication: authentication,
            restate: { role: 'caller', ingressUrl: `http://127.0.0.1:${ingress.address().port}` },
          }
          const now = new Date().toISOString()
          const request = {
            ...ControlApiFixtures.executionAcceptance.request,
            issuedAt: now,
            payload: {
              taskId: plan.correlation.taskId,
              agentId: plan.correlation.agentId,
              executionPlan: {
                executionPlanId: plan.executionPlanId,
                contentDigest: plan.contentDigest,
                schemaVersion: 1,
              },
              deadlineAt: new Date(Date.now() + 60_000).toISOString(),
              retentionExpiresAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
              maximumMicrounits: Number.MAX_SAFE_INTEGER,
              maximumTokens: Number.MAX_SAFE_INTEGER,
            },
          }
          function token(scopes = ['execution:accept'], workspaceIds = [request.workspaceId]) {
            const claims = {
              audience: authentication.audience,
              issuer: authentication.issuer,
              credentialId: 'budget-credential',
              credentialKind: 'service',
              keyId: 'budget-key',
              principalId: request.caller.servicePrincipalId,
              workspaceIds,
              projectIds: [request.projectId],
              scopes,
              issuedAt: new Date(Date.now() - 1000).toISOString(),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            }
            const signingInput = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: claims.keyId, typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
            return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`
          }
          async function open() {
            const composition = createManagedCloudControlApiComposition(configuration, {
              write() {},
            })
            const host = { composition, closed: false }
            hosts.push(host)
            const metadata = {
              serviceName: 'control-api',
              version: 'test',
              commitSha: 'test',
              environment: 'test',
              instanceId: 'budget-admission',
            }
            host.app = await createControlApiApplication({
              ...composition,
              metadata,
              logger: { write() {} },
              health: () => ({ status: 'ok', metadata }),
              readiness: () => ({ status: 'ready', metadata }),
            })
            return host
          }
          async function close(host) {
            if (host.closed) return
            await host.app?.close()
            await host.composition.connection.close()
            host.closed = true
          }
          const send = (host, payload = request, credential = token()) =>
            host.app.inject({
              method: 'POST',
              url: '/v1/executions/accept',
              headers: { authorization: `Bearer ${credential}` },
              payload,
            })
          const first = await open()
          expect((await send(first, request, token([]))).statusCode).toBe(401)
          expect((await send(first, request, token(['execution:validate']))).statusCode).toBe(403)
          expect(
            (await send(first, request, token(['execution:accept'], [id('wsp', 'H')]))).statusCode
          ).toBe(403)
          expect(await isolated.application.select().from(executions)).toHaveLength(0)
          expect(submissions).toBe(0)
          const accepted = await send(first)
          expect({ status: accepted.statusCode, body: accepted.json() }).toMatchObject({
            status: 202,
          })
          const executionId = accepted.json().data.executionId
          const ledger = new DurableUsageLedger({
            store: new PostgresDurableUsageStore(isolated.application),
          })
          expect(await ledger.summary(request.workspaceId, executionId)).toMatchObject({
            maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits,
            maximumTokens: plan.constraints.limits.tokens.maximumTotal,
          })
          expect(submissions).toBe(1)
          const child = deriveExecutionPlan(plan, {
            correlation: { ...plan.correlation, taskId: id('tsk', 'H'), requestId: id('req', 'H') },
            contextPackage: contextPackageSerializationFixtures.futurePi,
            constraints: plan.constraints,
            runtimeRequirements: plan.runtimeRequirements,
            outputContract: plan.outputContract,
            compiledAt: now,
          })
          await new PostgresExecutionPlanRepository(isolated.application).put(child)
          await ledger.reserve({
            workspaceId: request.workspaceId,
            executionId,
            reservationKey: 'consume-parent',
            maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits,
            maximumTokens: plan.constraints.limits.tokens.maximumTotal,
            source: { sourceId: 'capacity-fixture', idempotencyKey: 'consume-parent' },
          })
          const childRequest = {
            ...request,
            commandId: id('cmd', 'H'),
            requestId: child.correlation.requestId,
            idempotencyKey: 'child-budget-admission-0001',
            payloadHash: 'b'.repeat(64),
            payload: {
              ...request.payload,
              taskId: child.correlation.taskId,
              parentExecutionId: executionId,
              executionPlan: {
                executionPlanId: child.executionPlanId,
                contentDigest: child.contentDigest,
                schemaVersion: 1,
              },
            },
          }
          const before = await snapshot(isolated.application)
          const denied = await send(first, childRequest)
          expect(denied.statusCode).toBe(422)
          expect(denied.json().error.code).toBe('BUDGET_EXHAUSTED')
          expect(submissions).toBe(1)
          expect(await snapshot(isolated.application)).toEqual(before)
          await isolated.application.delete(executionPlans)
          await close(first)
          const reopened = await open()
          const replay = await send(reopened)
          expect(replay.statusCode).toBe(202)
          expect(replay.json().data).toMatchObject({ executionId, replayed: true })
          expect(await snapshot(isolated.application)).toEqual(before)
          expect(submissions).toBe(1)
          const [receipt] = await isolated.application
            .select()
            .from(usageOperationReceipts)
            .where(
              eq(usageOperationReceipts.idempotencyKey, `execution-budget-open:${executionId}`)
            )
          await isolated.application
            .update(usageOperationReceipts)
            .set({
              receipt: {
                ...receipt.receipt,
                result: { ...receipt.receipt.result, spentTokens: 1 },
              },
            })
            .where(eq(usageOperationReceipts.idempotencyKey, receipt.idempotencyKey))
          const damaged = await snapshot(isolated.application)
          const damagedReplay = await send(reopened)
          expect(damagedReplay.statusCode).toBe(503)
          expect(damagedReplay.json().error.code).toBe('BUDGET_ADMISSION_UNAVAILABLE')
          expect(JSON.stringify(damagedReplay.json())).not.toContain('STORE_STATE_INVALID')
          expect(await snapshot(isolated.application)).toEqual(damaged)
          expect(submissions).toBe(1)
        } finally {
          const closed = await Promise.allSettled(
            hosts.map(async (host) => {
              if (!host.closed) {
                const appClosed = await Promise.allSettled([host.app?.close()])
                const connectionClosed = await Promise.allSettled([
                  host.composition.connection.close(),
                ])
                const failures = [...appClosed, ...connectionClosed].filter(
                  (result) => result.status === 'rejected'
                )
                if (failures.length)
                  throw new AggregateError(
                    failures.map((result) => result.reason),
                    'Cloud budget host cleanup failed'
                  )
              }
            })
          )
          ingress.closeAllConnections()
          await new Promise((resolve) => ingress.close(resolve))
          disposalFailures = closed.filter((result) => result.status === 'rejected')
        }
        if (disposalFailures.length)
          throw new AggregateError(
            disposalFailures.map((result) => result.reason),
            'Cloud budget fixture cleanup failed'
          )
      },
      { migrate: false }
    )
  },
  60_000
)

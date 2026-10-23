import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { VersionedCatalog, ExecutionLifecycleService } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteExecutionRepository,
  SqliteCommandAcceptanceRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { SqliteVersionedCatalogRepository } from '@control-plane/sqlite-persistence/catalog'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { NodePiDurableLeadAdmission, deterministicPiLeadIntentIds } from './node-admission.ts'
import {
  DurablePiDurableLeadService,
  SqlitePiDurableLeadReceiptStore,
} from './pi-durable-lead.service.ts'
import { createUnusedPiLeadAllocationReleaser } from './unused-lead-allocation.ts'
import { PiDurableRuntimeAdapter } from '@control-plane/pi-durable-adapter'

const at = '2026-10-08T00:00:00.000Z'
const expiresAt = '2026-10-08T01:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
async function fixture(
  operation,
  {
    explicitProjectScope = false,
    canonicalActorPrincipalId = 'product:original-sender',
    runtimeCompatible = false,
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-node-admission-'))
  const path = join(directory, 'node.sqlite')
  let provider, database
  let currentTime = at
  const open = async () => {
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    database = new DatabaseSync(path)
    const executions = new SqliteExecutionRepository(provider)
    const plans = new SqliteExecutionPlanRepository(provider)
    const commandRepository = new SqliteCommandAcceptanceRepository(provider, {
      budgetAdmission: true,
    })
    const catalog = new SqliteVersionedCatalogRepository(provider)
    const usage = new SqliteDurableUsageStore(provider)
    return { executions, plans, commandRepository, catalog, usage }
  }
  try {
    let repositories = await open()
    const inputs = createExecutionPlanTestFixtureInputs()
    if (runtimeCompatible) inputs.profile.definition.capabilityRequirements = []
    inputs.profile.definition.skills = []
    inputs.skills = []
    const ids = deterministicPiLeadIntentIds(inputs.correlation.workspaceId, intentId)
    inputs.correlation.requestId = ids.requestId
    if (explicitProjectScope)
      inputs.correlation.executionScope = {
        schemaVersion: 1,
        kind: 'project',
        projectId: inputs.correlation.projectId,
      }
    const catalog = new VersionedCatalog(repositories.catalog, repositories.catalog)
    await catalog.createAgentProfile({
      profileId: inputs.profile.profileId,
      displayName: 'Pi lead fixture',
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
      publishedAt: at,
    })
    await new SqliteContextPackageRepository(provider).put(inputs.contextPackage)
    const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    await repositories.plans.put(plan)
    let evidence = {
      schemaVersion: 'pi-lead-intent/v1',
      intentId,
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      messageRef: 'message:one',
      authorityRevision: 1,
      principalRef: 'lead:one',
      ...(explicitProjectScope ? { canonicalActorPrincipalId } : {}),
      scopeRef: 'channel:one',
      expiresAt,
      allowedPrincipalIds: ['svc_adea'],
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      prompt: 'Canonical lead message',
      profileVersionId: plan.profile.profileVersionId,
      profileContentDigest: plan.profile.contentDigest,
    }
    const principal = {
      kind: 'agent_hq_service',
      principalId: 'svc_adea',
      workspaceIds: [evidence.workspaceId],
      projectIds: [evidence.projectId],
      scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
    }
    const scopeReadActors = []
    const scopeAuthority = {
      readCurrent: async (input) => {
        scopeReadActors.push(input.callerPrincipalId)
        return {
          workspaceId: plan.correlation.workspaceId,
          executionScope: plan.correlation.executionScope,
          callerPrincipalId: input.callerPrincipalId,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          principalActive: true,
          grantActive: true,
          allowedPrincipalIds: [canonicalActorPrincipalId, 'svc_pi-admission'],
          expiresAt,
          projectWorkspaceId: plan.correlation.workspaceId,
        }
      },
    }
    // A presented product body (e.g. a rollback fence) replaces the ordinary evidence read.
    let fenceBody
    const options = (overrides) => ({
      database,
      product: {
        readCurrent: async (input) => {
          if (fenceBody !== undefined) return structuredClone(fenceBody)
          return input.intentId === intentId ? structuredClone(evidence) : undefined
        },
      },
      resolvePlan: async () => plan,
      plans: repositories.plans,
      commandRepository: repositories.commandRepository,
      planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
        catalog: { profiles: repositories.catalog, skills: repositories.catalog },
        ...(explicitProjectScope ? { scopeAuthority, now: () => at } : {}),
      }),
      ...(explicitProjectScope ? { scopeAuthority, assertProviderReady: async () => {} } : {}),
      executions: repositories.executions,
      budgetAdmission: new DurableRuntimeBudgetAdmission({
        commands: repositories.commandRepository,
        store: repositories.usage,
      }),
      admissionPrincipalId: 'svc_pi-admission',
      now: () => currentTime,
      ...overrides,
    })
    const resolve = (bridge) =>
      bridge.resolveIntent({ workspaceId: plan.correlation.workspaceId, intentId, principal })
    const reopen = async () => {
      database.close()
      await provider.close()
      repositories = await open()
      return new NodePiDurableLeadAdmission(options())
    }
    const ledger = () => new DurableUsageLedger({ store: repositories.usage })
    const counts = () =>
      provider.transaction(async (transaction) => ({
        commands: (await transaction.list('command-inbox')).length,
        executions: (await transaction.list('executions')).length,
      }))
    await operation({
      bridge: new NodePiDurableLeadAdmission(options()),
      options,
      resolve,
      reopen,
      counts,
      ledger,
      principal,
      plan,
      ids,
      get repositories() {
        return repositories
      },
      scopeReadActors,
      getEvidence: () => structuredClone(evidence),
      setEvidence: (change) => {
        evidence = change === undefined ? undefined : { ...evidence, ...change }
      },
      setFenceBody: (body) => {
        fenceBody = body
      },
      get database() {
        return database
      },
      setTime: (value) => {
        currentTime = value
      },
      releaseUnused: (admission) =>
        createUnusedPiLeadAllocationReleaser({
          now: () => currentTime,
          transaction: (workspaceId, releaseOperation) =>
            provider.transaction((nativeTransaction) =>
              SqliteDurableUsageStore.withTransaction(nativeTransaction, workspaceId, (store) => {
                const bound = new Proxy(provider, {
                  get(target, property) {
                    if (property === 'transaction') return (callback) => callback(nativeTransaction)
                    const value = Reflect.get(target, property)
                    return typeof value === 'function' ? value.bind(target) : value
                  },
                })
                return releaseOperation({
                  executions: new SqliteExecutionRepository(bound),
                  ledger: new DurableUsageLedger({ store, now: () => currentTime }),
                })
              })
            ),
        })(admission),
    })
  } finally {
    database?.close()
    await provider?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('real SQLite CP admission mints exactly one accepted execution, attempt and canonical budget', async () => {
  await fixture(async (setup) => {
    const admission = await setup.resolve(setup.bridge)
    expect(JSON.stringify(setup.bridge.store.marker(intentId))).not.toContain(
      'preparationDeadlineAt'
    )
    expect(admission.admittedAttempt).toMatchObject({
      executionId: setup.ids.executionId,
      attemptId: setup.ids.attemptId,
      executionPlanId: setup.plan.executionPlanId,
    })
    expect(admission.startRequest.attemptBudget.maximumTokens).toBe(
      setup.plan.constraints.limits.tokens.maximumTotal
    )
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
    const summary = await setup
      .ledger()
      .summary(setup.plan.correlation.workspaceId, setup.ids.executionId)
    expect(summary.reservedTokens).toBe(setup.plan.constraints.limits.tokens.maximumTotal)
    expect(summary.reservedMicrounits).toBe(setup.plan.constraints.limits.budget.maximumMicrounits)
    await setup.bridge.assertCurrent(admission, setup.principal, 'dispatch')
    await setup.bridge.canonicalAuthority.assertAuthority({
      request: admission.startRequest,
      admission: await setup.bridge.canonicalAuthority.resolveAdmission(admission.startRequest),
    })
    const reopened = await setup.reopen()
    expect(await setup.resolve(reopened)).toEqual(admission)
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
  })
})

test('execution-to-admission lookup additively backfills a legacy SQLite store and rechecks product actor and live scope', () =>
  fixture(async (setup) => {
    const original = await setup.resolve(setup.bridge)
    const marker = setup.bridge.store.marker(intentId)
    const expectedActor = marker.intent.canonicalActorPrincipalId
    expect(expectedActor).toBe(fencedScope.canonicalActorPrincipalId)

    // Recreate the prior table shape to prove an existing database is upgraded in place.
    setup.database.exec(
      'DROP INDEX pi_lead_intent_admissions_execution_id_idx; ALTER TABLE pi_lead_intent_admissions DROP COLUMN execution_id'
    )
    const reopened = await setup.reopen()
    expect(
      reopened.store.database
        .prepare('PRAGMA table_info(pi_lead_intent_admissions)')
        .all()
        .some((column) => column.name === 'execution_id')
    ).toBe(true)
    expect(reopened.store.markerByExecutionId(setup.ids.executionId)).toMatchObject({
      intentId,
      workspaceId: setup.plan.correlation.workspaceId,
      intent: { executionId: setup.ids.executionId },
    })

    setup.scopeReadActors.length = 0
    const recovered = await reopened.resolveRetainedAdmissionByExecutionId({
      executionId: setup.ids.executionId,
      workspaceId: setup.plan.correlation.workspaceId,
      principal: setup.principal,
    })
    expect(recovered).toEqual(original)
    expect(setup.scopeReadActors.length).toBeGreaterThan(0)
    expect(setup.scopeReadActors).toContain(expectedActor)
    expect(setup.scopeReadActors).not.toContain('svc_adea')
  }, fencedScope))

test('execution-to-admission lookup fails closed for mismatched workspace, plan pin, or current product actor', async () => {
  await fixture(async (setup) => {
    await setup.resolve(setup.bridge)
    await expect(
      setup.bridge.resolveRetainedAdmissionByExecutionId({
        executionId: setup.ids.executionId,
        workspaceId: `${setup.plan.correlation.workspaceId.slice(0, -1)}${
          setup.plan.correlation.workspaceId.endsWith('A') ? 'B' : 'A'
        }`,
        principal: {
          ...setup.principal,
          workspaceIds: [
            `${setup.plan.correlation.workspaceId.slice(0, -1)}${
              setup.plan.correlation.workspaceId.endsWith('A') ? 'B' : 'A'
            }`,
          ],
        },
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')

    const executions = setup.repositories.executions
    const getExecution = executions.getExecution.bind(executions)
    executions.getExecution = async (executionId) => {
      const execution = await getExecution(executionId)
      return {
        ...execution,
        executionPlan: {
          ...execution.executionPlan,
          contentDigest: `sha256:${'f'.repeat(64)}`,
        },
      }
    }
    await expect(
      setup.bridge.resolveRetainedAdmissionByExecutionId({
        executionId: setup.ids.executionId,
        workspaceId: setup.plan.correlation.workspaceId,
        principal: setup.principal,
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    executions.getExecution = getExecution

    setup.setEvidence({
      canonicalActorPrincipalId: 'user:6a9c2a11-8a71-4d9a-9bb9-a5dd90b343d8',
    })
    await expect(
      setup.bridge.resolveRetainedAdmissionByExecutionId({
        executionId: setup.ids.executionId,
        workspaceId: setup.plan.correlation.workspaceId,
        principal: setup.principal,
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
  }, fencedScope)
})

test('execution-to-admission lookup refuses legacy markers without a canonical product actor', () =>
  fixture(async (setup) => {
    await setup.resolve(setup.bridge)
    const marker = setup.bridge.store.marker(intentId)
    const { canonicalActorPrincipalId: _actor, executionScope: _scope, ...intent } = marker.intent
    setup.database
      .prepare('UPDATE pi_lead_intent_admissions SET record = ? WHERE intent_id = ?')
      .run(
        JSON.stringify({
          ...marker,
          planPin: { ...marker.planPin, schemaVersion: 1 },
          intent,
        }),
        intentId
      )
    expect(() => setup.bridge.store.markerByExecutionId(setup.ids.executionId)).not.toThrow()
    await expect(
      setup.bridge.resolveRetainedAdmissionByExecutionId({
        executionId: setup.ids.executionId,
        workspaceId: setup.plan.correlation.workspaceId,
        principal: setup.principal,
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
  }, fencedScope))

test('execution-to-admission lookup never treats a service principal as the canonical product actor', () =>
  fixture(async (setup) => {
    await setup.resolve(setup.bridge)
    const marker = setup.bridge.store.marker(intentId)
    setup.setEvidence({ canonicalActorPrincipalId: 'svc_adea' })
    const evidence = setup.getEvidence()
    const evidenceDigest = `sha256:${createHash('sha256')
      .update(canonicalJsonStringify({ evidence, planPin: marker.planPin }) ?? 'null')
      .digest('hex')}`
    const forged = {
      ...marker,
      evidenceDigest,
      intent: { ...marker.intent, canonicalActorPrincipalId: 'svc_adea' },
    }
    setup.database
      .prepare('UPDATE pi_lead_intent_admissions SET digest = ?, record = ? WHERE intent_id = ?')
      .run(evidenceDigest, JSON.stringify(forged), intentId)
    await expect(
      setup.bridge.resolveRetainedAdmissionByExecutionId({
        executionId: setup.ids.executionId,
        workspaceId: setup.plan.correlation.workspaceId,
        principal: setup.principal,
      })
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
  }, fencedScope))

test('execution-to-admission lookup refuses schema-v1 replay with a retained actor but revoked current scope', async () => {
  await fixture(async (setup) => {
    const canonicalActorPrincipalId = 'user:9e04fbf7-2e5a-4e46-8df1-7f8392e88273'
    setup.setEvidence({ canonicalActorPrincipalId })
    await setup.resolve(setup.bridge)
    const marker = setup.bridge.store.marker(intentId)
    expect(marker.planPin.schemaVersion).toBe(1)
    expect(marker.intent.executionScope).toBeUndefined()
    expect(marker.intent.canonicalActorPrincipalId).toBe(canonicalActorPrincipalId)

    const scopeReadActors = []
    const revokedActorScope = {
      readCurrent: async (input) => {
        scopeReadActors.push(input.callerPrincipalId)
        return {
          workspaceId: setup.plan.correlation.workspaceId,
          executionScope: {
            schemaVersion: 1,
            kind: 'project',
            projectId: setup.plan.correlation.projectId,
          },
          callerPrincipalId: input.callerPrincipalId,
          executionPlan: {
            executionPlanId: setup.plan.executionPlanId,
            contentDigest: setup.plan.contentDigest,
            schemaVersion: setup.plan.schemaVersion,
          },
          principalActive: input.callerPrincipalId !== canonicalActorPrincipalId,
          grantActive: input.callerPrincipalId !== canonicalActorPrincipalId,
          allowedPrincipalIds: ['svc_pi-admission'],
          expiresAt,
          projectWorkspaceId: setup.plan.correlation.workspaceId,
        }
      },
    }

    await setup.reopen()
    const planValidator = new ExecutionPlanAcceptanceValidator(setup.repositories.plans, {
      catalog: {
        profiles: setup.repositories.catalog,
        skills: setup.repositories.catalog,
      },
      scopeAuthority: revokedActorScope,
      now: () => at,
    })
    const reopened = new NodePiDurableLeadAdmission(
      setup.options({ scopeAuthority: revokedActorScope, planValidator })
    )
    await expect(
      reopened.resolveRetainedAdmissionByExecutionId({
        executionId: setup.ids.executionId,
        workspaceId: setup.plan.correlation.workspaceId,
        principal: setup.principal,
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')
    expect(scopeReadActors).toEqual([])
    expect(reopened.store.marker(intentId)).toEqual(marker)
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
  })
})

test('corrupt interrupted marker cannot reserve or release another real unused allocation', async () =>
  fixture(async (setup) => {
    const victim = await setup.resolve(setup.bridge)
    const sourceIntentId = '8d14934e-cec6-4a43-a2ad-1fc983314967'
    const sourceIds = deterministicPiLeadIntentIds(
      setup.plan.correlation.workspaceId,
      sourceIntentId
    )
    const marker = structuredClone(setup.bridge.store.marker(intentId))
    marker.intentId = sourceIntentId
    marker.intent.intentId = sourceIntentId
    marker.preparationDeadlineAt = '2026-10-08T00:05:00.000Z'
    marker.state = 'pending'
    // The interrupted source row pins its own attempt, while corrupt JSON points
    // at a genuine accepted victim with a canonical queued attempt and allowance.
    setup.database
      .prepare(
        'INSERT INTO pi_lead_intent_admissions (intent_id, workspace_id, attempt_id, digest, state, record) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        sourceIntentId,
        marker.workspaceId,
        sourceIds.attemptId,
        marker.evidenceDigest,
        'pending',
        JSON.stringify(marker)
      )
    const before = await setup
      .ledger()
      .summary(marker.workspaceId, victim.admittedAttempt.executionId)
    let reservations = 0,
      releases = 0
    const budgetAdmission = setup.options().budgetAdmission
    const bridge = new NodePiDurableLeadAdmission(
      setup.options({
        budgetAdmission: {
          reserve: async (input) => {
            reservations++
            return budgetAdmission.reserve(input)
          },
        },
      })
    )
    setup.setTime(marker.preparationDeadlineAt)
    await expect(
      bridge.recoverUnclaimedPreparations(
        async (admission) => {
          releases++
          await setup.releaseUnused(admission)
        },
        async () => false
      )
    ).rejects.toMatchObject({ code: 'PI_LEAD_AUTHORITY_CONFLICT' })
    expect(reservations).toBe(0)
    expect(releases).toBe(0)
    expect(
      (await setup.repositories.executions.getExecution(victim.admittedAttempt.executionId)).state
    ).toBe('accepted')
    expect(
      (await setup.repositories.executions.getAttempt(victim.admittedAttempt.attemptId)).state
    ).toBe('queued')
    expect(
      await setup.ledger().summary(marker.workspaceId, victim.admittedAttempt.executionId)
    ).toEqual(before)
  }))

test('retained marker refuses corrupted SQL pins, unbounded fields, scope and actor before cleanup', async () =>
  fixture(async (setup) => {
    await setup.resolve(setup.bridge)
    const marker = structuredClone(setup.bridge.store.marker(intentId))
    const mutations = [
      { workspace_id: 'wsp_01JABCDEF0123456789ABCDEFH' },
      { attempt_id: 'att_01JABCDEF0123456789ABCDEFG' },
      { digest: `sha256:${'f'.repeat(64)}` },
      { state: 'unrecognized' },
      { record: { ...marker, unknown: true } },
      { record: { ...marker, actorPrincipalId: '' } },
      { record: { ...marker, intent: { ...marker.intent, messageRef: 'x'.repeat(257) } } },
      {
        record: {
          ...marker,
          intent: { ...marker.intent, executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
        },
      },
      {
        record: {
          ...marker,
          intent: { ...marker.intent, executionScope: { schemaVersion: 1, kind: 'workspace' } },
        },
      },
      { record: { ...marker, preparationDeadlineAt: expiresAt } },
    ]
    for (const mutation of mutations) {
      const column = Object.keys(mutation)[0]
      const value = column === 'record' ? JSON.stringify(mutation.record) : mutation[column]
      setup.database
        .prepare(`UPDATE pi_lead_intent_admissions SET ${column} = ? WHERE intent_id = ?`)
        .run(value, intentId)
      expect(() => setup.bridge.store.marker(intentId)).toThrow('PI_LEAD_AUTHORITY_CONFLICT')
      setup.database
        .prepare(
          'UPDATE pi_lead_intent_admissions SET workspace_id = ?, attempt_id = ?, digest = ?, state = ?, record = ? WHERE intent_id = ?'
        )
        .run(
          marker.workspaceId,
          marker.intent.attemptId,
          marker.evidenceDigest,
          marker.state,
          JSON.stringify(marker),
          intentId
        )
    }
    expect(setup.bridge.store.marker(intentId)).toEqual(marker)
  }))

for (const boundary of [
  'after_marker',
  'after_accept',
  'after_attempt',
  'after_budget',
  'after_mapping',
]) {
  test(`unclaimed preparation ${boundary} releases actual unused allocation after SQLite reopen`, async () =>
    fixture(async (setup) => {
      const interrupted = new NodePiDurableLeadAdmission(
        setup.options({
          checkpoint: (point) => {
            if (point === boundary) throw new Error('PRIVATE_INTERRUPTION')
          },
        })
      )
      await expect(
        interrupted.resolveIntent({
          workspaceId: setup.plan.correlation.workspaceId,
          intentId,
          principal: setup.principal,
          operation: 'prepare',
        })
      ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      const deadline = setup.bridge.store.marker(intentId).preparationDeadlineAt
      expect(deadline).toBe('2026-10-08T00:05:00.000Z')
      const reopened = await setup.reopen()
      setup.setTime(deadline)
      // Cleanup uses retained canonical acceptance, not ambient product/provider grants.
      reopened.options.product.readCurrent = async () => {
        throw new Error('NO_CURRENT_GRANT')
      }
      let callbacks = 0
      const release = async (admission) => {
        callbacks++
        await setup.releaseUnused(admission)
      }
      expect(await reopened.recoverUnclaimedPreparations(release, async () => false)).toEqual({
        released: 1,
        pending: 0,
      })
      expect(await reopened.recoverUnclaimedPreparations(release, async () => false)).toEqual({
        released: boundary === 'after_marker' ? 1 : 0,
        pending: 0,
      })
      expect(reopened.store.marker(intentId).state).toBe('released')
      if (boundary === 'after_marker') {
        expect(callbacks).toBe(0)
        expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
      } else {
        expect(callbacks).toBe(1)
        expect(
          (await setup.repositories.executions.getExecution(setup.ids.executionId)).state
        ).toBe('cancelled')
        expect((await setup.repositories.executions.getAttempt(setup.ids.attemptId)).state).toBe(
          'cancelled'
        )
        const entries = await setup
          .ledger()
          .entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
        for (const kind of ['credit', 'reservation', 'release', 'settlement'])
          expect(entries.filter((entry) => entry.kind === kind)).toHaveLength(1)
        expect(
          (await setup.ledger().summary(setup.plan.correlation.workspaceId, setup.ids.executionId))
            .reservedTokens
        ).toBe(0)
      }
      expect(JSON.stringify(reopened.store.marker(intentId))).not.toContain('PRIVATE_INTERRUPTION')
    }))
}

test('preparation deadline is retained without renewal and claimed dispatched work stays readable after expiry', async () =>
  fixture(async (setup) => {
    const request = {
      workspaceId: setup.plan.correlation.workspaceId,
      intentId,
      principal: setup.principal,
    }
    const admitted = await setup.bridge.resolveIntent({ ...request, operation: 'prepare' })
    expect(admitted.deadlineAt).toBe('2026-10-08T00:05:00.000Z')
    setup.setTime('2026-10-08T00:04:59.000Z')
    expect(
      (await setup.bridge.resolveIntent({ ...request, operation: 'prepare' })).deadlineAt
    ).toBe(admitted.deadlineAt)
    setup.setTime(admitted.deadlineAt)
    const before = setup.bridge.store.marker(intentId)
    expect(
      await setup.bridge.recoverUnclaimedPreparations(setup.releaseUnused, async () => true)
    ).toEqual({ released: 0, pending: 0 })
    expect(setup.bridge.store.marker(intentId)).toEqual(before)
    for (const operation of ['prepare', 'dispatch'])
      await expect(setup.bridge.resolveIntent({ ...request, operation })).rejects.toThrow(
        'PI_LEAD_DEADLINE_EXPIRED'
      )
    for (const operation of ['status', 'progress', 'cancel']) {
      expect((await setup.bridge.resolveIntent({ ...request, operation })).admissionDigest).toBe(
        admitted.admissionDigest
      )
      await setup.bridge.assertCurrent(admitted, setup.principal, operation)
    }
  }))

test('failed unused release retries from retained marker after reopen without reserving cancelled work again', async () =>
  fixture(async (setup) => {
    await setup.bridge.resolveIntent({
      workspaceId: setup.plan.correlation.workspaceId,
      intentId,
      principal: setup.principal,
      operation: 'prepare',
    })
    setup.setTime('2026-10-08T00:05:00.000Z')
    const failAfterCommit = async (admission) => {
      await setup.releaseUnused(admission)
      throw new Error('PRIVATE_LATE_ERROR')
    }
    expect(
      await setup.bridge.recoverUnclaimedPreparations(failAfterCommit, async () => false)
    ).toEqual({ released: 0, pending: 1 })
    expect(setup.bridge.store.marker(intentId).state).toBe('releasing')
    const reopened = await setup.reopen()
    expect(
      await reopened.recoverUnclaimedPreparations(setup.releaseUnused, async () => false)
    ).toEqual({ released: 1, pending: 0 })
    expect(
      (
        await setup.ledger().entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      ).filter((entry) => entry.kind === 'settlement')
    ).toHaveLength(1)
  }))

test('late canonical acceptance cannot escape cleanup after an expired marker was observed without execution', async () =>
  fixture(async (setup) => {
    let releaseAccept, signalEntered
    const gate = new Promise((resolve) => {
      releaseAccept = resolve
    })
    const entered = new Promise((resolve) => {
      signalEntered = resolve
    })
    const commands = new Proxy(setup.repositories.commandRepository, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property === 'accept')
          return async (...args) => {
            signalEntered()
            await gate
            return value.apply(target, args)
          }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const suspended = new NodePiDurableLeadAdmission(setup.options({ commandRepository: commands }))
    const waiting = suspended
      .resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'prepare',
      })
      .then(
        () => undefined,
        (error) => error
      )
    await entered
    setup.setTime('2026-10-08T00:05:00.000Z')
    expect(
      await setup.bridge.recoverUnclaimedPreparations(setup.releaseUnused, async () => false)
    ).toEqual({ released: 1, pending: 0 })
    releaseAccept()
    expect((await waiting).message).toBe('PI_LEAD_DEADLINE_EXPIRED')
    expect(
      await setup.bridge.recoverUnclaimedPreparations(setup.releaseUnused, async () => false)
    ).toEqual({ released: 1, pending: 0 })
    expect((await setup.repositories.executions.getExecution(setup.ids.executionId)).state).toBe(
      'cancelled'
    )
    expect(
      (await setup.ledger().summary(setup.plan.correlation.workspaceId, setup.ids.executionId))
        .reservedTokens
    ).toBe(0)
  }))

for (const boundary of [
  'after_marker',
  'after_accept',
  'after_attempt',
  'after_budget',
  'after_mapping',
]) {
  test(`physical SQLite reopen replays ${boundary} without duplicate work or budget`, async () => {
    await fixture(async (setup) => {
      const interrupted = new NodePiDurableLeadAdmission(
        setup.options({
          checkpoint: (point) => {
            if (point === boundary) throw new Error('secret-crash-diagnostic')
          },
        })
      )
      await expect(setup.resolve(interrupted)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      const recovered = await setup.reopen()
      const admission = await setup.resolve(recovered)
      expect(admission.startRequest.attemptId).toBe(setup.ids.attemptId)
      expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
      expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(
        1
      )
      const entries = await setup
        .ledger()
        .entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      expect(entries.filter((entry) => entry.kind === 'credit')).toHaveLength(1)
      expect(entries.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
    })
  })
}

test('pending immutable marker rejects changed product prompt or provider selection after crash', async () => {
  for (const change of [{ prompt: 'Changed message' }, { selectionRevision: 2 }]) {
    await fixture(async (setup) => {
      const interrupted = new NodePiDurableLeadAdmission(
        setup.options({
          checkpoint: (point) => {
            if (point === 'after_marker') throw new Error('crash')
          },
        })
      )
      await expect(setup.resolve(interrupted)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      setup.setEvidence(change)
      await expect(setup.resolve(await setup.reopen())).rejects.toThrow(
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
    })
  }
})

test('message deletion and current audience revocation prevent accepted replay', async () => {
  for (const change of [undefined, { allowedPrincipalIds: ['svc_other'] }]) {
    await fixture(async (setup) => {
      await setup.resolve(setup.bridge)
      setup.setEvidence(change)
      await expect(setup.resolve(await setup.reopen())).rejects.toThrow()
      expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    })
  }
})

test('missing canonical budget admission never publishes a ready intent mapping', async () => {
  await fixture(async (setup) => {
    const bridge = new NodePiDurableLeadAdmission(
      setup.options({
        commandRepository: new SqliteCommandAcceptanceRepository(
          setup.repositories.executions.provider
        ),
      })
    )
    await expect(setup.resolve(bridge)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(await bridge.store.get(intentId)).toBeUndefined()
  })
})

test('superseding canonical attempt fails cold replay instead of minting a third attempt', async () => {
  await fixture(async (setup) => {
    await setup.resolve(setup.bridge)
    await setup.ledger().settle({
      workspaceId: setup.plan.correlation.workspaceId,
      executionId: setup.ids.executionId,
      reservationKey: `runtime-attempt:${setup.ids.attemptId}`,
      source: { sourceId: 'known-no-effect', idempotencyKey: 'known-no-effect:settle' },
    })
    const execution = await setup.repositories.executions.getExecution(setup.ids.executionId)
    await new ExecutionLifecycleService(setup.repositories.executions).createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
      expectedExecutionVersion: execution.version,
      queuedAt: at,
    })
    await expect(setup.resolve(await setup.reopen())).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(2)
  })
})

test('terminal status keeps current audience and historical allocation without reopening spend', async () => {
  await fixture(async (setup) => {
    const admission = await setup.resolve(setup.bridge)
    await setup.ledger().settle({
      workspaceId: setup.plan.correlation.workspaceId,
      executionId: setup.ids.executionId,
      reservationKey: `runtime-attempt:${setup.ids.attemptId}`,
      source: { sourceId: 'known-no-effect', idempotencyKey: 'terminal-read:settle' },
    })
    const execution = await setup.repositories.executions.getExecution(setup.ids.executionId)
    await new ExecutionLifecycleService(setup.repositories.executions).transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: at,
    })
    const reopened = await setup.reopen()
    const read = await reopened.resolveIntent({
      workspaceId: setup.plan.correlation.workspaceId,
      intentId,
      principal: setup.principal,
      operation: 'status',
    })
    expect(read).toEqual(admission)
    await reopened.assertCurrent(read, setup.principal, 'status')
    await expect(setup.resolve(reopened)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    setup.setEvidence({ allowedPrincipalIds: ['svc_other'] })
    await expect(
      reopened.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')
    expect(
      (
        await setup.ledger().entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      ).filter((entry) => entry.kind === 'reservation')
    ).toHaveLength(1)
  })
})

test('read operations cannot mint an execution even for a principal with accept scope', async () => {
  await fixture(async (setup) => {
    await expect(
      setup.bridge.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_MISSING')
    expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
  })
})

test('product authority is read for observation on status, progress, children and cancel, and for inference on prepare and dispatch', async () => {
  await fixture(async (setup) => {
    const purposes = []
    const read = setup.bridge.options.product.readCurrent
    setup.bridge.options.product.readCurrent = async (input, context) => {
      purposes.push(context?.purpose)
      return read(input, context)
    }
    const seen = {}
    for (const operation of ['prepare', 'dispatch', 'status', 'progress', 'children', 'cancel']) {
      purposes.length = 0
      // Each call may refuse later (nothing is admitted here); only the product read purpose matters.
      await setup.bridge
        .resolveIntent({
          workspaceId: setup.plan.correlation.workspaceId,
          intentId,
          principal: setup.principal,
          operation,
        })
        .catch(() => undefined)
      seen[operation] = [...new Set(purposes)]
    }
    expect(seen).toEqual({
      prepare: ['inference'],
      dispatch: ['inference'],
      status: ['observe'],
      progress: ['observe'],
      children: ['observe'],
      cancel: ['observe'],
    })
  })
})

test('provider readiness is bound to the canonical actor and denies before markers or funding', async () => {
  await fixture(async (setup) => {
    let seen
    const bridge = new NodePiDurableLeadAdmission(
      setup.options({
        assertProviderReady: async (input) => {
          seen = input
          throw new Error('CONNECTION_REVOKED')
        },
      })
    )
    await expect(setup.resolve(bridge)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(seen.actorPrincipalId).toBe(setup.principal.principalId)
    expect(seen.ids).toEqual(setup.ids)
    expect(seen.plan.contentDigest).toBe(setup.plan.contentDigest)
    expect(seen.evidence.selectionRevision).toBe(1)
    expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(0)
    expect(
      setup.database.prepare('SELECT record FROM pi_lead_intent_admissions').all()
    ).toHaveLength(0)
    expect(
      await setup.repositories.usage.transaction(
        setup.plan.correlation.workspaceId,
        (transaction) => transaction.getBudget(setup.ids.executionId)
      )
    ).toBeUndefined()
  })
})

test('explicit scope refuses a missing original actor or provider readiness before all admission records', async () => {
  for (const missing of ['actor', 'readiness'])
    await fixture(
      async (setup) => {
        if (missing === 'actor') setup.setEvidence({ canonicalActorPrincipalId: undefined })
        const bridge = new NodePiDurableLeadAdmission(
          setup.options(missing === 'readiness' ? { assertProviderReady: undefined } : {})
        )
        await expect(setup.resolve(bridge)).rejects.toThrow(
          missing === 'actor' ? 'PI_LEAD_SCOPE_REJECTED' : 'PI_LEAD_PROVIDER_READINESS_REQUIRED'
        )
        expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
        expect(
          await setup.repositories.executions.listAttempts(setup.ids.executionId)
        ).toHaveLength(0)
        expect(
          setup.database.prepare('SELECT record FROM pi_lead_intent_admissions').all()
        ).toHaveLength(0)
        expect(
          await setup.repositories.usage.transaction(
            setup.plan.correlation.workspaceId,
            (transaction) => transaction.getBudget(setup.ids.executionId)
          )
        ).toBeUndefined()
      },
      { explicitProjectScope: true }
    )
})

test('current CP catalog revocation blocks replay and runtime authority without reminting', async () => {
  await fixture(async (setup) => {
    const admission = await setup.resolve(setup.bridge)
    const profile = await setup.repositories.catalog.getAgentProfileVersion(
      setup.plan.profile.profileVersionId
    )
    const catalog = new VersionedCatalog(setup.repositories.catalog, setup.repositories.catalog)
    await catalog.revokeAgentProfileVersion(
      profile.profileVersionId,
      profile.revision,
      at,
      'fixture policy revocation'
    )
    const reopened = await setup.reopen()
    await expect(setup.resolve(reopened)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    await expect(
      reopened.canonicalAuthority.resolveAdmission(admission.startRequest)
    ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
  })
})

test('concurrent canonical admission requests converge on one CP identity and allocation', async () => {
  await fixture(async (setup) => {
    const peers = [
      setup.bridge,
      new NodePiDurableLeadAdmission(setup.options()),
      new NodePiDurableLeadAdmission(setup.options()),
    ]
    const outcomes = await Promise.allSettled(peers.map((peer) => setup.resolve(peer)))
    // Independent SQLite connections may return bounded busy failures. Drain
    // every contender before exact retry, so no live transaction is abandoned.
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
    const admissions = []
    for (const peer of peers) admissions.push(await setup.resolve(peer))
    expect(admissions[1]).toEqual(admissions[0])
    expect(admissions[2]).toEqual(admissions[0])
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
    expect(
      (
        await setup.ledger().entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      ).filter((entry) => entry.kind === 'reservation')
    ).toHaveLength(1)
  })
})

test('provider-native secrets are rejected before marker, command or budget persistence', async () => {
  await fixture(async (setup) => {
    setup.setEvidence({ credential: 'provider-native-secret-canary' })
    try {
      await setup.resolve(setup.bridge)
      throw new Error('unexpected admission')
    } catch (error) {
      expect(error.message).toBe('PI_LEAD_UNAVAILABLE')
      expect(JSON.stringify(error)).not.toContain('provider-native-secret-canary')
    }
    expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
    expect(
      setup.database.prepare('SELECT record FROM pi_lead_intent_admissions').all()
    ).toHaveLength(0)
  })
})

test('workspace-only product evidence requires explicit project scope before any CP admission', async () => {
  for (const projectId of [null, undefined]) {
    await fixture(async (setup) => {
      setup.setEvidence({ projectId })
      await expect(setup.resolve(setup.bridge)).rejects.toThrow('PI_LEAD_PROJECT_SCOPE_REQUIRED')
      expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
      expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(
        0
      )
      expect(
        await setup.repositories.usage.transaction(
          setup.plan.correlation.workspaceId,
          (transaction) => transaction.getBudget(setup.ids.executionId)
        )
      ).toBeUndefined()
      expect(
        setup.database.prepare('SELECT record FROM pi_lead_intent_admissions').all()
      ).toHaveLength(0)
    })
  }
})

// M18.01.3 retained admission binding. Real ordinary admission and dispatch over disposable SQLite,
// then a v2 fence presented after the durable store reopens. Stub adapter only at the runtime edge.
const fencedScope = {
  explicitProjectScope: true,
  canonicalActorPrincipalId: 'user:2b1a7e26-8c3f-4f4f-9a1e-77d19b7d5e11',
}
const digestOf = (value) =>
  `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(value) ?? 'null')
    .digest('hex')}`
const effects = (calls) => ({
  start: calls.start.length,
  status: calls.status.length,
  progress: calls.progress.length,
  cancel: calls.cancel.length,
})
const envelope = (setup, operation, payload, idempotencyKey) => ({
  caller: { servicePrincipalId: 'svc_adea' },
  contractVersion: { major: 1, minor: 0 },
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId: setup.plan.correlation.workspaceId,
  correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  idempotencyKey,
  payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
  operation,
  issuedAt: at,
  payload,
})
const readEnvelope = (setup, operation, parameters) => ({
  caller: { servicePrincipalId: 'svc_adea' },
  contractVersion: { major: 1, minor: 0 },
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId: setup.plan.correlation.workspaceId,
  correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
  operation,
  requestedAt: at,
  parameters,
})
/** A v2 fence built from the retained marker's own revision, scope, audience and canonical actor. */
function fenceBodyFrom(bridge) {
  const marker = bridge.store.marker(intentId)
  return {
    schemaVersion: 'pi-lead-intent-fence/v2',
    intentId,
    workspaceId: marker.workspaceId,
    dispatchPermitted: false,
    rollbackFence: {
      fencedAt: at,
      reason: 'operator_intervention',
      actor: { kind: 'operator', operatorId: 'ops.lead' },
    },
    authorityRevision: marker.intent.authorityRevision,
    canonicalActorPrincipalId: marker.intent.canonicalActorPrincipalId,
    scopeRef: marker.intent.scopeRef,
    allowedPrincipalIds: [...marker.intent.allowedPrincipalIds],
  }
}
/** Ordinary admission through the real service dispatch, with a recording adapter stub. */
async function admitAndDispatch(setup) {
  const handle = {
    handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
    attemptId: setup.ids.attemptId,
    externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    startedAt: at,
  }
  const calls = { start: [], status: [], progress: [], cancel: [] }
  let retained
  const adapter = {
    start: async (request) => {
      calls.start.push(request)
      retained = {
        request: structuredClone(request),
        admission: await setup.bridge.canonicalAuthority.resolveAdmission(request),
        handle,
      }
      return handle
    },
    status: async (observed) => {
      calls.status.push(observed)
      return { handle: observed, state: 'running', observedAt: at }
    },
    progress: async function* (observed) {
      calls.progress.push(observed)
      yield { handleId: observed.handleId, sequence: 1, occurredAt: at, type: 'status', data: {} }
    },
    cancel: async (observed, options) => {
      calls.cancel.push({ handle: observed, options })
      return { handle: observed, state: 'cancelling', observedAt: at }
    },
    findRetainedAdmission: async (observed) =>
      observed.handleId === handle.handleId ? structuredClone(retained) : undefined,
    cancelFenced: async (observed, options, authorize) => {
      const current = await adapter.findRetainedAdmission(observed)
      if (!current) throw new Error('retained admission is missing')
      await authorize(current)
      return adapter.cancel(observed, options)
    },
  }
  const receipts = new SqlitePiDurableLeadReceiptStore(setup.database)
  const service = new DurablePiDurableLeadService({
    authority: setup.bridge,
    receipts,
    adapter,
    fence: adapter,
    now: () => at,
  })
  const response = await service.dispatch(
    envelope(setup, 'pi-durable.lead.dispatch', { intentId }, 'transport:dispatch'),
    setup.principal
  )
  return { adapter, calls, receipts, handle, dispatchId: response.data.dispatchId }
}

test('ordinary admission retains a binding that survives reopen: a v2 fence observes and cancels the original handle, and prepare or dispatch never run', async () =>
  fixture(async (setup) => {
    const { adapter, calls, receipts, handle, dispatchId } = await admitAndDispatch(setup)
    const receipt = await receipts.get(dispatchId)
    // The retained binding is exactly the admission the dispatched receipt was built from.
    expect(setup.bridge.store.admissionBinding(intentId)).toMatchObject({
      executionId: receipt.executionId,
      attemptId: receipt.attemptId,
      admissionDigest: receipt.admissionDigest,
      startDigest: receipt.startDigest,
      deadlineAt: receipt.deadlineAt,
    })
    const binding = setup.bridge.store.admissionBinding(intentId)

    // The durable store closes and reopens before the fence is presented.
    const reopened = await setup.reopen()
    const reopenedReceipts = new SqlitePiDurableLeadReceiptStore(setup.database)
    const service = new DurablePiDurableLeadService({
      authority: reopened,
      receipts: reopenedReceipts,
      adapter,
      fence: adapter,
      now: () => at,
    })
    expect(reopened.store.admissionBinding(intentId)).toEqual(binding)
    setup.setFenceBody(fenceBodyFrom(reopened))

    const dispatched = effects(calls)
    const status = await service.status(
      readEnvelope(setup, 'pi-durable.lead.status', { dispatchId }),
      setup.principal
    )
    expect(status.data).toMatchObject({
      dispatchId,
      state: 'running',
      runtimeSessionId: handle.externalSessionId,
    })
    const progress = await service.progress(
      readEnvelope(setup, 'pi-durable.lead.progress', { dispatchId }),
      setup.principal
    )
    expect(progress.data.events).toHaveLength(1)
    const cancelled = await service.cancel(
      envelope(setup, 'pi-durable.lead.cancel', { dispatchId }, 'transport:cancel-original'),
      setup.principal
    )
    expect(cancelled.data.state).toBe('cancelling')
    // Every effect reached the original retained handle; nothing started.
    expect(calls.status.at(-1)).toEqual(handle)
    expect(calls.progress.at(-1)).toEqual(handle)
    expect(calls.cancel.at(-1)).toMatchObject({
      handle,
      options: { idempotencyKey: 'transport:cancel-original' },
    })
    const observed = effects(calls)
    expect(observed).toEqual({
      start: dispatched.start,
      status: dispatched.status + 1,
      progress: dispatched.progress + 1,
      cancel: dispatched.cancel + 1,
    })
    expect(await reopenedReceipts.get(dispatchId)).toEqual(receipt)

    // Under the fence nothing is prepared, dispatched or admitted again.
    const counts = await setup.counts()
    await expect(
      reopened.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'prepare',
      })
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    await expect(
      service.dispatch(
        envelope(setup, 'pi-durable.lead.dispatch', { intentId }, 'transport:dispatch-fenced'),
        setup.principal
      )
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(effects(calls)).toEqual(observed)
    expect(await setup.counts()).toEqual(counts)

    // A principal outside the fence's audience is refused by the fenced audience check.
    await expect(
      reopened.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: { ...setup.principal, principalId: 'svc_pi-admission' },
        operation: 'cancel',
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')
  }, fencedScope))

const childRecord = (setup, changes = {}) => ({
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: setup.ids.executionId,
  parentAttemptId: setup.ids.attemptId,
  childExecutionId: 'exe_01JABCDEF0123456789ABCDEFH',
  childAttemptId: 'att_01JABCDEF0123456789ABCDEFH',
  role: 'researcher',
  objective: 'PRIVATE-OBJECTIVE-CANARY',
  state: 'completed',
  terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
  terminalPublication: { status: 'published', idempotencyKey: 'delegation:terminal:one' },
  retryCount: 0,
  revision: 3,
  acceptedAt: at,
  updatedAt: at,
  ...changes,
})

test('children read is refused under a v2 fence that appears during the child read, and before it, while status still observes', async () =>
  fixture(async (setup) => {
    const { adapter, calls, receipts, dispatchId } = await admitAndDispatch(setup)
    const listed = []
    const service = new DurablePiDurableLeadService({
      authority: setup.bridge,
      receipts,
      adapter,
      fence: adapter,
      now: () => at,
      childDelegations: {
        async listChildren(executionId) {
          listed.push(executionId)
          // The real Node authority switches from ordinary admission to a matching pinned v2
          // fence while the child records are being read.
          if (listed.length === 1) setup.setFenceBody(fenceBodyFrom(setup.bridge))
          return [childRecord(setup)]
        },
      },
    })
    const request = readEnvelope(setup, 'pi-durable.lead.children', { dispatchId })

    // Ordinary admission: the read works against the current authority.
    setup.setFenceBody(undefined)
    const before = effects(calls)
    listed.length = 0
    // First read: the fence appears during listChildren, so the post-read reread refuses and
    // no child outcome is returned.
    await expect(service.children(request, setup.principal)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(listed).toHaveLength(1)

    // The fence is now present: the lookup refuses before any child record is read.
    await expect(service.children(request, setup.principal)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(listed).toHaveLength(1)

    // The same fence still permits the pinned status observation; children is not part of it.
    const status = await service.status(
      readEnvelope(setup, 'pi-durable.lead.status', { dispatchId }),
      setup.principal
    )
    expect(status.data.dispatchId).toBe(dispatchId)
    expect(effects(calls)).toEqual({ ...before, status: before.status + 1 })

    // The authority itself refuses the new operation under any fence variant.
    await expect(
      setup.bridge.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'children',
      })
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')

    // Lifting the fence restores the ordinary read, with the same bounded view.
    setup.setFenceBody(undefined)
    const ordinary = await service.children(request, setup.principal)
    expect(ordinary.data.children).toHaveLength(1)
    expect(ordinary.data).toMatchObject({ totalChildren: 1, complete: true })
    expect(JSON.stringify(ordinary)).not.toContain('PRIVATE-OBJECTIVE-CANARY')
  }, fencedScope))

test('a fence present at the first reread refuses children even when the second reread would pass', async () =>
  fixture(async (setup) => {
    const { adapter, receipts, dispatchId } = await admitAndDispatch(setup)
    let listings = 0
    const service = new DurablePiDurableLeadService({
      authority: setup.bridge,
      receipts,
      adapter,
      now: () => at,
      childDelegations: {
        async listChildren() {
          listings++
          return [childRecord(setup)]
        },
      },
    })
    setup.setFenceBody(fenceBodyFrom(setup.bridge))
    await expect(
      service.children(
        readEnvelope(setup, 'pi-durable.lead.children', { dispatchId }),
        setup.principal
      )
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(listings).toBe(0)
  }, fencedScope))

test('tampered admission binding refuses fenced observation and cancel before any adapter effect', async () =>
  fixture(async (setup) => {
    const { adapter, calls, dispatchId } = await admitAndDispatch(setup)
    const reopened = await setup.reopen()
    const service = new DurablePiDurableLeadService({
      authority: reopened,
      receipts: new SqlitePiDurableLeadReceiptStore(setup.database),
      adapter,
      fence: adapter,
      now: () => at,
    })
    setup.setFenceBody(fenceBodyFrom(reopened))
    // A raw edit leaves the record's self-digest stale.
    setup.database
      .prepare(
        "UPDATE pi_lead_intent_admission_bindings SET record = json_set(record, '$.admissionDigest', ?) WHERE intent_id = ?"
      )
      .run(digestOf('forged-admission'), intentId)
    const before = effects(calls)
    await expect(
      service.status(readEnvelope(setup, 'pi-durable.lead.status', { dispatchId }), setup.principal)
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    await expect(
      service.cancel(
        envelope(setup, 'pi-durable.lead.cancel', { dispatchId }, 'transport:cancel-tampered'),
        setup.principal
      )
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    expect(effects(calls)).toEqual(before)
  }, fencedScope))

test('tampered receipt admission digest refuses fenced observation and cancel before any adapter effect', async () =>
  fixture(async (setup) => {
    const { adapter, calls, dispatchId } = await admitAndDispatch(setup)
    const reopened = await setup.reopen()
    const service = new DurablePiDurableLeadService({
      authority: reopened,
      receipts: new SqlitePiDurableLeadReceiptStore(setup.database),
      adapter,
      fence: adapter,
      now: () => at,
    })
    setup.setFenceBody(fenceBodyFrom(reopened))
    // The binding stays intact; only the receipt is edited, so the receipt-to-binding check refuses.
    setup.database
      .prepare(
        "UPDATE pi_lead_receipts SET record = json_set(record, '$.admissionDigest', ?) WHERE dispatch_id = ?"
      )
      .run(digestOf('forged-receipt'), dispatchId)
    const before = effects(calls)
    await expect(
      service.status(readEnvelope(setup, 'pi-durable.lead.status', { dispatchId }), setup.principal)
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    await expect(
      service.cancel(
        envelope(setup, 'pi-durable.lead.cancel', { dispatchId }, 'transport:cancel-forged'),
        setup.principal
      )
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    expect(effects(calls)).toEqual(before)
  }, fencedScope))

test('a record without an admission binding stays unavailable and is never backfilled by ordinary reads', async () =>
  fixture(async (setup) => {
    const { adapter, calls, dispatchId } = await admitAndDispatch(setup)
    setup.database
      .prepare('DELETE FROM pi_lead_intent_admission_bindings WHERE intent_id = ?')
      .run(intentId)
    const reopened = await setup.reopen()
    const service = new DurablePiDurableLeadService({
      authority: reopened,
      receipts: new SqlitePiDurableLeadReceiptStore(setup.database),
      adapter,
      now: () => at,
    })
    setup.setFenceBody(fenceBodyFrom(reopened))
    const before = effects(calls)
    await expect(
      service.status(readEnvelope(setup, 'pi-durable.lead.status', { dispatchId }), setup.principal)
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    await expect(
      service.progress(
        readEnvelope(setup, 'pi-durable.lead.progress', { dispatchId }),
        setup.principal
      )
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    await expect(
      service.cancel(
        envelope(setup, 'pi-durable.lead.cancel', { dispatchId }, 'transport:cancel-legacy'),
        setup.principal
      )
    ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(effects(calls)).toEqual(before)

    // An ordinary read of the already-ready marker writes no binding.
    setup.setFenceBody(undefined)
    await reopened.resolveIntent({
      workspaceId: setup.plan.correlation.workspaceId,
      intentId,
      principal: setup.principal,
      operation: 'dispatch',
    })
    expect(reopened.store.admissionBinding(intentId)).toBeUndefined()
    expect(
      setup.database
        .prepare('SELECT COUNT(*) AS count FROM pi_lead_intent_admission_bindings')
        .get().count
    ).toBe(0)
  }, fencedScope))

test('admission binding is write-once: an identical replay is a no-op and a conflicting record is refused without overwrite', async () =>
  fixture(async (setup) => {
    await admitAndDispatch(setup)
    const binding = setup.bridge.store.admissionBinding(intentId)
    setup.bridge.store.bindAdmission(binding)
    expect(setup.bridge.store.admissionBinding(intentId)).toEqual(binding)

    // A fully re-digested record with a different admission digest still conflicts.
    const record = { ...binding }
    delete record.bindingDigest
    const conflicting = { ...record, admissionDigest: digestOf('conflicting-admission') }
    expect(() =>
      setup.bridge.store.bindAdmission({ ...conflicting, bindingDigest: digestOf(conflicting) })
    ).toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    expect(setup.bridge.store.admissionBinding(intentId)).toEqual(binding)
  }, fencedScope))

// Crash boundaries of the ordinary admission that authorizes a marker. A simulated crash throws at a
// checkpoint, then the durable SQLite store reopens. Invariant at every boundary: the marker is ready
// if and only if its admission binding is durably published.
const admissionCrashPoints = [
  'after_marker',
  'after_accept',
  'after_attempt',
  'after_budget',
  'before_publish',
  'after_mapping',
]
const readyAndBindings = (database) => ({
  state: database
    .prepare('SELECT state FROM pi_lead_intent_admissions WHERE intent_id = ?')
    .get(intentId)?.state,
  bindings: database
    .prepare('SELECT COUNT(*) AS count FROM pi_lead_intent_admission_bindings WHERE intent_id = ?')
    .get(intentId).count,
})

test('a crash at any admission boundary leaves ready and binding both durable or both absent, and a retry publishes the binding', async () => {
  const report = []
  for (const point of admissionCrashPoints) {
    await fixture(async (setup) => {
      const crashing = new NodePiDurableLeadAdmission(
        setup.options({
          checkpoint: async (name) => {
            if (name === point) throw new Error(`CRASH_${point}`)
          },
        })
      )
      const outcome = await setup.resolve(crashing).then(
        () => 'resolved',
        (error) => error.message
      )
      const crashed = readyAndBindings(setup.database)
      const reopened = await setup.reopen()
      const admission = await setup.resolve(reopened)
      const healed = readyAndBindings(setup.database)
      setup.setFenceBody(fenceBodyFrom(reopened))
      const observed = await reopened.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'status',
      })
      setup.setFenceBody(undefined)
      // Fenced observation carries the immutable retained binding, never a fresh admission.
      expect(observed.retained).toEqual({
        intentId,
        workspaceId: setup.plan.correlation.workspaceId,
        executionId: setup.ids.executionId,
        attemptId: setup.ids.attemptId,
        allowedPrincipalIds: admission.allowedPrincipalIds,
        executionPlanId: setup.plan.executionPlanId,
        executionPlanDigest: setup.plan.contentDigest,
        admissionDigest: admission.admissionDigest,
        startDigest: digestOf(admission.startRequest),
        deadlineAt: admission.deadlineAt,
      })
      expect(readyAndBindings(setup.database)).toEqual(healed)
      report.push({
        point,
        outcome,
        atomic: (crashed.state === 'ready') === (crashed.bindings === 1),
        healed: `${healed.state}/${healed.bindings}`,
        bindingMatches:
          reopened.store.admissionBinding(intentId)?.admissionDigest === admission.admissionDigest,
        fencedResultIsReadOnly:
          observed.kind === 'fenced' &&
          !('admissionDigest' in observed) &&
          !('startRequest' in observed) &&
          observed.operation === 'status',
      })
    }, fencedScope)
  }
  expect(report).toEqual(
    admissionCrashPoints.map((point) => ({
      point,
      outcome: 'PI_LEAD_UNAVAILABLE',
      atomic: true,
      healed: 'ready/1',
      bindingMatches: true,
      fencedResultIsReadOnly: true,
    }))
  )
})

test('a conflicting binding found at publication rolls the ready transition back so the marker stays pending', async () =>
  fixture(async (setup) => {
    const crashing = new NodePiDurableLeadAdmission(
      setup.options({
        checkpoint: async (name) => {
          if (name === 'before_publish') throw new Error('CRASH_before_publish')
        },
      })
    )
    await expect(setup.resolve(crashing)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    // A divergent record for the same intent exists before publication: it must refuse, not overwrite.
    setup.database
      .prepare('INSERT INTO pi_lead_intent_admission_bindings VALUES (?, ?)')
      .run(intentId, JSON.stringify({ schemaVersion: 'divergent' }))
    const reopened = await setup.reopen()
    await expect(setup.resolve(reopened)).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    expect(readyAndBindings(setup.database)).toEqual({ state: 'pending', bindings: 1 })
  }, fencedScope))

const deferred = () => {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test('public canonical reads never expose a pending intent, even while its own projection is held inside an await', async () =>
  fixture(async (setup) => {
    const entered = deferred()
    const released = deferred()
    const real = setup.options().budgetAdmission
    let bridge
    // Only the projection reserves after this pending marker's budget is bound; creation reserves before that.
    const gated = {
      reserve: async (input) => {
        if (
          bridge?.store.findBudget(intentId) &&
          bridge.store.marker(intentId)?.state === 'pending'
        ) {
          entered.resolve()
          await released.promise
        }
        return real.reserve(input)
      },
    }
    bridge = new NodePiDurableLeadAdmission(setup.options({ budgetAdmission: gated }))
    const admitting = setup.resolve(bridge).then(
      (value) => value,
      (error) => error
    )
    let admitted
    try {
      await entered.promise

      // A concurrent caller on the same store and authority sees no pending canonical intent.
      expect(await bridge.store.get(intentId)).toBeUndefined()
      expect(await bridge.store.getByAttempt(setup.ids.attemptId)).toBeUndefined()
      await expect(
        bridge.canonicalAuthority.get(
          intentId,
          setup.plan.correlation.workspaceId,
          setup.principal.principalId,
          'read'
        )
      ).rejects.toThrow()
    } finally {
      // Always release and settle the held admission so teardown never races an open transaction.
      released.resolve()
      admitted = await admitting
    }
    expect(admitted).toMatchObject({ admittedAttempt: { attemptId: setup.ids.attemptId } })
    expect(await bridge.store.get(intentId)).toMatchObject({ intentId })
  }, fencedScope))

// Scripted engine only: canonical CP/Node authority and funding are real, no provider is called.
test.each([
  ['cancelling CP lifecycle', true, false, null],
  ['withheld model readiness', false, true, null],
  ['both lifecycle and readiness', true, true, null],
  ['revoked audience before observation', true, true, 'audience-before'],
  ['changed actor before observation', true, true, 'actor-before'],
  ['revoked scope before observation', true, true, 'scope-before'],
  ['revoked audience during observation', true, true, 'audience-during'],
  ['revoked scope during observation', true, true, 'scope-during'],
  ['expiry during observation', true, true, 'expiry-during'],
  ['inference recovery with cancelling lifecycle', true, false, 'inference'],
  ['inference recovery with withheld readiness', false, true, 'inference'],
])(
  'retained cancellation recovery observes authority with %s',
  async (_label, cancelling, withheld, fault) => {
    await fixture(
      async (setup) => {
        const admission = await setup.resolve(setup.bridge)
        const canonical = setup.bridge.canonicalAuthority
        const directory = await mkdtemp(join(tmpdir(), 'pi-node-cancel-recovery-'))
        const runtimeEffects = { providers: 0, engines: 0, authorizations: 0, probes: 0 }
        let adapter
        const purposes = []
        let refuseInference = false
        let scopeActive = true
        let currentTime = at
        const scope = setup.options().scopeAuthority
        const revoke = () => {
          if (fault?.startsWith('audience')) setup.setEvidence({ allowedPrincipalIds: [] })
          if (fault?.startsWith('actor'))
            setup.setEvidence({ canonicalActorPrincipalId: 'product:other' })
          if (fault?.startsWith('scope')) scopeActive = false
          if (fault?.startsWith('expiry')) {
            currentTime = expiresAt
            setup.setTime(expiresAt)
          }
        }
        const read = setup.bridge.options.product.readCurrent
        setup.bridge.options.product.readCurrent = async (input, context) => {
          purposes.push(context.purpose)
          if (refuseInference && context.purpose === 'inference') throw new Error('MODEL_NOT_READY')
          return read(input, context)
        }
        const options = {
          directory,
          now: () => currentTime,
          scopeAuthority: {
            readCurrent: async (input) => ({
              ...(await scope.readCurrent(input)),
              grantActive: scopeActive,
            }),
          },
          resolveAdmission: (request) => canonical.resolveAdmission(request),
          assertAuthority: (authority, purpose) => canonical.assertAuthority(authority, purpose),
          assertReadAuthority: (authority) => canonical.assertReadAuthority(authority),
          assertRecoveryAuthority: (authority) => canonical.assertRecoveryAuthority(authority),
          resolveProvider: async (selection) => {
            runtimeEffects.providers++
            return {
              selectionRef: selection.selectionRef,
              selectionRevision: selection.selectionRevision,
              workspaceId: setup.plan.correlation.workspaceId,
              provider: 'scripted',
              providerModel: 'cancel-model',
              location: 'remote_host',
              harness: 'pi_durable',
              harnessVersion: '1.1.0',
              providerBinding: 'pi_durable_models',
              withModels: async (use) => use({}),
            }
          },
          authorizeInference: async () => {
            runtimeEffects.authorizations++
            return { maxOutputTokens: 10, maximumInputTokens: 64, assertActive: async () => {} }
          },
          settleUsage: async (_authority, _key, usage) => usage,
          reconcileInference: async () => {
            runtimeEffects.probes++
            if (fault?.endsWith('-during')) revoke()
            return 'safe_to_resume'
          },
          engineFactory: async (engine) => {
            runtimeEffects.engines++
            return {
              run: async () => {
                await engine.authorizeInference({
                  sessionId: 'cancel-session',
                  inferenceId: 'pi-generation:1',
                  provider: 'scripted',
                  modelId: 'cancel-model',
                })
                throw new Error('RETAIN_UNCERTAIN_GENERATION')
              },
              close: async () => {},
              cancel: async () => {},
            }
          },
        }
        try {
          adapter = new PiDurableRuntimeAdapter(options)
          const handle = await adapter.start(admission.startRequest)
          await adapter.drain()
          expect((await adapter.status(handle)).state).toBe('unknown')
          if (fault !== 'inference')
            expect(
              (await adapter.cancel(handle, { idempotencyKey: 'stop:retained', requestedAt: at }))
                .state
            ).toBe('cancelling')
          await adapter.close()
          if (cancelling) {
            const execution = await setup.repositories.executions.getExecution(
              setup.ids.executionId
            )
            await new ExecutionLifecycleService(setup.repositories.executions).transitionExecution({
              executionId: execution.executionId,
              expectedVersion: execution.version,
              to: 'cancelling',
              transitionedAt: at,
            })
          }
          refuseInference = withheld
          purposes.length = 0
          setup.scopeReadActors.length = 0
          const before = { ...runtimeEffects }
          const funding = await setup
            .ledger()
            .entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
          adapter = new PiDurableRuntimeAdapter(options)
          if (fault?.endsWith('-before')) revoke()
          if (fault) {
            await expect(adapter.reconcile(handle)).rejects.toThrow(
              /PI_AUTHORITY_REJECTED|PI_EXECUTION_SCOPE_REJECTED|PI_AUTHORITY_EXPIRED/
            )
            expect(adapter.journal.get(handle.handleId).state).toBe(
              fault === 'inference' ? 'unknown' : 'cancelling'
            )
          } else expect((await adapter.reconcile(handle)).state).toBe('cancelled')
          expect(runtimeEffects).toEqual({
            ...before,
            probes: before.probes + (fault && !fault.endsWith('-during') ? 0 : 1),
          })
          if (!fault) {
            expect(purposes.length).toBeGreaterThan(0)
            expect(new Set(purposes)).toEqual(new Set(['observe']))
            expect(setup.scopeReadActors).toContain('product:original-sender')
            expect(new Set(setup.scopeReadActors)).toEqual(
              new Set(['product:original-sender', 'svc_pi-admission'])
            )
          }
          expect(
            await setup.ledger().entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
          ).toEqual(funding)
          expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
        } finally {
          await adapter?.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      { explicitProjectScope: true, runtimeCompatible: true }
    )
  }
)

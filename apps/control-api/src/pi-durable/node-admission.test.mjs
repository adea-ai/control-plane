import { test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createUnusedPiLeadAllocationReleaser } from './unused-lead-allocation.ts'

const at = '2026-10-08T00:00:00.000Z'
const expiresAt = '2026-10-08T01:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
async function fixture(operation, { explicitProjectScope = false } = {}) {
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
      ...(explicitProjectScope ? { canonicalActorPrincipalId: 'product:original-sender' } : {}),
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
    const scopeAuthority = {
      readCurrent: async (input) => ({
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
        allowedPrincipalIds: ['product:original-sender', 'svc_pi-admission'],
        expiresAt,
        projectWorkspaceId: plan.correlation.workspaceId,
      }),
    }
    const options = (overrides) => ({
      database,
      product: {
        readCurrent: async (input) =>
          input.intentId === intentId ? structuredClone(evidence) : undefined,
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
      setEvidence: (change) => {
        evidence = change === undefined ? undefined : { ...evidence, ...change }
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
      .prepare('INSERT INTO pi_lead_intent_admissions VALUES (?, ?, ?, ?, ?, ?)')
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

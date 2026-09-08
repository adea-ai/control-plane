import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  contextPackageSerializationFixtures,
  composeProviderContextPackage,
} from '@control-plane/context'
import { NeonEncryptedSecretProvider } from '@control-plane/credential-vault'
import {
  EvaluationService,
  createEvidenceAuditMetricsExecutor,
  evidenceAuditFixtureDigest,
} from '@control-plane/production-readiness'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  ExecutionReconciliationService,
  InteractionService,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
} from '@control-plane/domain'
import { ExecutionEventDispatcher, ExecutionEventService } from '@control-plane/events'
import {
  ExecutionPlanAcceptanceValidator,
  executionValidationPayloadHash,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { ExternalSessionRegistry, RuntimeConnectionRegistry } from '@control-plane/runtime-sdk'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresContextAuthoringCommandRepository } from './context-authoring-command-repository.ts'
import { contextAuthoringCommands } from './schema/context-authoring-commands.ts'
import { PostgresEncryptedSecretStore } from './credential-secret-store.ts'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { PostgresExecutionEventRepository } from './execution-event-repository.ts'
import { PostgresExternalSessionRepository } from './external-session-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionValidationCommandRepository } from './validation-command-repository.ts'
import { PostgresEvaluationRepository } from './evaluation-repository.ts'
import { PostgresInteractionRepository } from './interaction-repository.ts'
import { PostgresInteractionCommandRepository } from './interaction-command-repository.ts'
import { PostgresExecutionCancellationRepository } from './execution-cancellation-repository.ts'
import { PostgresMemoryWriteProposalRepository } from './memory-write-proposal-repository.ts'
import {
  PostgresProjectStateRepository,
  PostgresStatePromotionProposalRepository,
} from './project-state-repository.ts'
import { PostgresReconciliationCheckpointRepository } from './reconciliation-checkpoint-repository.ts'
import { PostgresReleaseAuditRepository } from './release-audit-repository.ts'
import { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.ts'
import { PostgresRuntimeHealthIngestionService } from './runtime-health-ingestion.ts'
import { PostgresRuntimeHealthEventDispatcher } from './runtime-health-dispatcher.ts'
import { acceptRuntimeHealthFixture } from './runtime-health-consumer-fixture.mjs'
import { PostgresRuntimeDiscoveryRepository } from './runtime-discovery-repository.ts'
import { PostgresRuntimeCommandRepository } from './runtime-command-repository.ts'
import { PostgresRuntimeEventEffectSink } from './runtime-event-effect-sink.ts'
import { PostgresRuntimeInventoryCheckpointRepository } from './runtime-inventory-checkpoint-repository.ts'
import { PostgresRuntimeChannelOwnershipRepository } from './runtime-channel-ownership-repository.ts'
import { PostgresUsageLedgerRepository } from './usage-ledger-repository.ts'
import {
  commandInbox,
  contextPackages,
  credentialSecrets,
  delegations,
  evaluationRuns,
  executionEvents,
  executionPlans,
  executionValidationCommands,
  executions,
  externalSessions,
  inboxMessages,
  interactionRequests,
  outboxEvents,
  projectStateRevisions,
  projectStates,
  reconciliationCheckpoints,
  releaseAuditRecords,
  retiredCommandKeys,
  runtimeCommands,
  runtimeEventReceipts,
  runtimeInventoryCheckpoints,
  runtimeConnections,
  runtimeDiscoveryProjections,
  statePromotionProposals,
} from './schema/index.ts'
import { createIsolatedTestDatabase } from './testing.ts'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

describe.skipIf(!integrationEnabled)('PostgreSQL persistence foundation', () => {
  let isolated

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
  })

  afterAll(async () => {
    await isolated?.dispose()
  })

  test('migrates an empty database and re-applies migrations deterministically', async () => {
    await isolated.migrate()
    await isolated.migrate()

    const result = await isolated.application.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `)
    expect(result.map(({ table_name: tableName }) => tableName)).toEqual(
      expect.arrayContaining([
        'execution_attempts',
        'execution_plans',
        'delegations',
        'executions',
        'evaluation_runs',
        'external_sessions',
        'inbox_messages',
        'memory_write_proposals',
        'outbox_events',
        'reconciliation_checkpoints',
        'release_audit_records',
        'runtime_connections',
        'runtime_discovery_projections',
        'runtime_inventory_checkpoints',
      ])
    )
  })

  test('persists aad-v1 credential rows and marks pre-migration rows as fail-closed legacy', async () => {
    await isolated.migrate()
    const store = new PostgresEncryptedSecretStore(isolated.application)
    const provider = new NeonEncryptedSecretProvider({
      store,
      encryptionKey: 'a'.repeat(64),
      keyReference: 'control-plane-secret-key-v1',
    })
    const reference = await provider.store({
      credentialId: 'cred_01JABCDEF0123456789ABCDEFG',
      revision: 1,
      secret: 'database-secret-value',
    })

    expect(await provider.resolve(reference)).toBe('database-secret-value')
    expect(
      await isolated.application
        .select({ encryptionVersion: credentialSecrets.encryptionVersion })
        .from(credentialSecrets)
        .where(eq(credentialSecrets.locator, reference.locator))
    ).toEqual([{ encryptionVersion: 'aad-v1' }])

    const legacyLocator = 'neon://credential-secrets/cred_01JBBCDEF0123456789ABCDEFG'
    await isolated.application.insert(credentialSecrets).values({
      locator: legacyLocator,
      version: '1',
      ciphertext: 'AA',
      iv: 'AAAAAAAAAAAAAAAA',
      authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
      keyReference: 'control-plane-secret-key-v1',
    })
    expect(await store.get({ locator: legacyLocator, version: '1' })).toMatchObject({
      encryptionVersion: 'legacy-v0',
    })
    await expect(
      provider.resolve({
        backend: 'neon-encrypted',
        locator: legacyLocator,
        version: '1',
        keyReference: 'control-plane-secret-key-v1',
        encryptionVersion: 'aad-v1',
        ciphertextDigest: `sha256:${'0'.repeat(64)}`,
      })
    ).rejects.toThrow('SECRET_LEGACY_FORMAT')
  })

  test('persists immutable execution plans across repository restart', async () => {
    await isolated.migrate()
    const plan = createExecutionPlanTestFixture()
    const repository = new PostgresExecutionPlanRepository(isolated.application)
    const reference = await repository.put(plan)

    expect(reference).toEqual({
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    })
    expect(await repository.put(plan)).toEqual(reference)

    const restarted = new PostgresExecutionPlanRepository(isolated.application)
    expect(await restarted.get(reference)).toEqual(plan)
    expect(
      await restarted.get({ ...reference, contentDigest: `sha256:${'f'.repeat(64)}` })
    ).toBeUndefined()
    expect(await isolated.application.select().from(executionPlans)).toHaveLength(1)

    const validator = new ExecutionPlanAcceptanceValidator(restarted)
    expect(
      await validator.validate({
        executionPlan: { ...reference, schemaVersion: plan.schemaVersion },
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        taskId: plan.correlation.taskId,
        agentId: plan.correlation.agentId,
      })
    ).toBe(true)

    await expect(
      repository.put({
        ...plan,
        contentDigest: `sha256:${'f'.repeat(64)}`,
      })
    ).rejects.toThrow()
  })

  test('persists ProjectState history, mutation replay, and promotion CAS across restart', async () => {
    await isolated.migrate()
    const repository = new PostgresProjectStateRepository(isolated.application)
    const proposals = new PostgresStatePromotionProposalRepository(isolated.application)
    const service = new ProjectStateService(
      repository,
      proposals,
      new RecordingProjectStateEventPublisher()
    )
    const scope = {
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    }
    await service.initialize({ ...scope, at: '2026-08-28T12:00:00.000Z' })
    const mutation = {
      ...scope,
      mutationId: 'stm_01JABCDEF0123456789ABCDEFG',
      expectedRevision: 0,
      actorPrincipalRef: 'principal://operator',
      operations: [
        {
          kind: 'append',
          item: {
            itemId: 'psi_01JABCDEF0123456789ABCDEFG',
            key: 'project.objective',
            value: 'Ship the Cloud reference',
            sensitivity: 'internal',
            freshness: { observedAt: '2026-08-28T12:01:00.000Z' },
            provenance: {
              sourceKind: 'principal',
              sourcePrincipalRef: 'principal://operator',
              artifactRefs: [],
              capturedAt: '2026-08-28T12:01:00.000Z',
            },
          },
        },
      ],
      at: '2026-08-28T12:01:00.000Z',
    }
    expect((await service.applyMutation(mutation)).applied).toBe(true)

    const restartedRepository = new PostgresProjectStateRepository(isolated.application)
    const restartedProposals = new PostgresStatePromotionProposalRepository(isolated.application)
    const restarted = new ProjectStateService(
      restartedRepository,
      restartedProposals,
      new RecordingProjectStateEventPublisher()
    )
    expect((await restarted.applyMutation(mutation)).applied).toBe(false)
    expect((await restarted.getHistory(scope)).map(({ revision }) => revision)).toEqual([0, 1])

    const proposal = await restarted.createPromotionProposal({
      ...scope,
      proposalId: 'spp_01JABCDEF0123456789ABCDEFG',
      baseRevision: 1,
      sourceExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
      operations: [
        {
          kind: 'append',
          item: {
            itemId: 'psi_01JBBCDEF0123456789ABCDEFG',
            key: 'execution.result',
            value: { status: 'verified' },
            sensitivity: 'internal',
            freshness: { observedAt: '2026-08-28T12:02:00.000Z' },
            provenance: {
              sourceKind: 'execution',
              sourceExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
              sourcePrincipalRef: 'agent://cloud-worker',
              artifactRefs: [],
              capturedAt: '2026-08-28T12:02:00.000Z',
            },
          },
        },
      ],
      createdAt: '2026-08-28T12:02:00.000Z',
      expiresAt: '2026-08-29T12:02:00.000Z',
    })
    expect(
      await restartedProposals.compareAndSet(proposal.revision, {
        ...proposal,
        revision: proposal.revision + 1,
        operations: [
          {
            ...proposal.operations[0],
            item: { ...proposal.operations[0].item, value: { status: 'tampered' } },
          },
        ],
      })
    ).toBe(false)
    const reviews = await Promise.allSettled([
      restarted.approvePromotion({
        proposalId: proposal.proposalId,
        reviewingPrincipalRef: 'principal://reviewer-a',
        reviewedAt: '2026-08-28T12:03:00.000Z',
      }),
      restarted.approvePromotion({
        proposalId: proposal.proposalId,
        reviewingPrincipalRef: 'principal://reviewer-b',
        reviewedAt: '2026-08-28T12:03:00.000Z',
      }),
    ])
    expect(reviews.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(reviews.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect((await restartedProposals.get(proposal.proposalId))?.state).toBe('approved')
    expect(
      await restarted.mergePromotion({
        proposalId: proposal.proposalId,
        mutationId: 'stm_01JBBCDEF0123456789ABCDEFG',
        mergedAt: '2026-08-28T12:04:00.000Z',
      })
    ).toMatchObject({ state: 'merged', resultingProjectStateRevision: 2 })

    const createTransitionProposal = (proposalId, itemId, key, expiresAt) =>
      restarted.createPromotionProposal({
        ...scope,
        proposalId,
        baseRevision: 2,
        sourceExecutionId: proposal.sourceExecutionId,
        operations: [
          {
            ...proposal.operations[0],
            item: { ...proposal.operations[0].item, itemId, key },
          },
        ],
        createdAt: '2026-08-28T12:05:00.000Z',
        expiresAt: expiresAt ?? '2026-08-29T12:05:00.000Z',
      })
    const rejected = await createTransitionProposal(
      'spp_01JBBCDEF0123456789ABCDEFG',
      'psi_01JBBCDEF0123456789ABCDEFG',
      'execution.rejected'
    )
    expect(
      await restarted.rejectPromotion({
        proposalId: rejected.proposalId,
        reviewingPrincipalRef: 'principal://reviewer-a',
        reviewedAt: '2026-08-28T12:06:00.000Z',
        reason: 'not applicable',
      })
    ).toMatchObject({ state: 'rejected' })
    const expiring = await createTransitionProposal(
      'spp_01JCBCDEF0123456789ABCDEFG',
      'psi_01JCBCDEF0123456789ABCDEFG',
      'execution.expired',
      '2026-08-28T12:07:00.000Z'
    )
    expect(
      await restarted.expirePromotion(expiring.proposalId, '2026-08-28T12:07:01.000Z')
    ).toMatchObject({ state: 'expired' })
    const superseded = await createTransitionProposal(
      'spp_01JDBCDEF0123456789ABCDEFG',
      'psi_01JDBCDEF0123456789ABCDEFG',
      'execution.old'
    )
    const successor = await createTransitionProposal(
      'spp_01JEBCDEF0123456789ABCDEFG',
      'psi_01JEBCDEF0123456789ABCDEFG',
      'execution.new'
    )
    expect(
      await restarted.supersedePromotion(
        superseded.proposalId,
        successor.proposalId,
        '2026-08-28T12:08:00.000Z'
      )
    ).toMatchObject({ state: 'superseded', supersededByProposalId: successor.proposalId })
    expect(await isolated.application.select().from(projectStates)).toHaveLength(1)
    expect(await isolated.application.select().from(projectStateRevisions)).toHaveLength(3)
    expect(await isolated.application.select().from(statePromotionProposals)).toHaveLength(5)
  })

  test('persists immutable ContextPackages across restart and fails closed on tampering', async () => {
    await isolated.migrate()
    const package_ = contextPackageSerializationFixtures.futurePi
    const repository = new PostgresContextPackageRepository(isolated.application)
    const reference = await repository.put(package_)
    expect(await repository.put(package_)).toEqual(reference)

    const restarted = new PostgresContextPackageRepository(isolated.application)
    expect(await restarted.get(reference)).toEqual(package_)
    expect(await restarted.getById(package_.contextPackageId)).toEqual(package_)
    expect(
      await restarted.get({ ...reference, contentDigest: `sha256:${'0'.repeat(64)}` })
    ).toBeUndefined()

    await isolated.application.execute(
      sql`update context_packages set context_package = jsonb_set(context_package, '{objective}', '"tampered"'::jsonb)`
    )
    await expect(restarted.get(reference)).rejects.toThrow()
    await expect(restarted.getById(package_.contextPackageId)).rejects.toThrow()
    expect(await isolated.application.select().from(contextPackages)).toHaveLength(1)
  })

  test('atomically retains the first context authoring result and rolls back failed command writes', async () => {
    await isolated.migrate()
    const repository = new PostgresContextAuthoringCommandRepository(isolated.application)
    const packages = new PostgresContextPackageRepository(isolated.application)
    const candidates = [
      contextPackageSerializationFixtures.futureAcp,
      contextPackageSerializationFixtures.futureLangGraph,
    ]
    const scope = {
      principalRef: 'service:authoring-integration',
      ...candidates[0].projectState,
      operation: 'context.author',
      idempotencyKey: 'context-authoring-integration-0001',
    }
    delete scope.revision
    const recordFor = (package_, key = scope.idempotencyKey) => ({
      scope: { ...scope, idempotencyKey: key },
      payloadHash: `sha256:${'d'.repeat(64)}`,
      contextPackage: {
        contextPackageId: package_.contextPackageId,
        contentDigest: package_.contentDigest,
      },
    })
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        const package_ = candidates[index % 2]
        return repository.commit(recordFor(package_), package_)
      })
    )
    expect(
      results.every(
        (record) =>
          record.contextPackage.contextPackageId === results[0].contextPackage.contextPackageId
      )
    ).toBe(true)
    const winner = await packages.get(results[0].contextPackage)
    expect(winner).toBeDefined()
    const loser = candidates.find(
      (candidate) => candidate.contextPackageId !== winner.contextPackageId
    )
    expect(await packages.getById(loser.contextPackageId)).toBeUndefined()
    expect(
      await new PostgresContextAuthoringCommandRepository(isolated.application).get(scope)
    ).toEqual(results[0])
    await expect(
      repository.commit({ ...recordFor(winner), payloadHash: `sha256:${'e'.repeat(64)}` }, winner)
    ).rejects.toThrow('CONTEXT_AUTHORING_COMMAND_CONFLICT')
    expect(await repository.get({ ...scope, principalRef: 'service:other' })).toBeUndefined()

    const [storedCommand] = await isolated.application.select().from(contextAuthoringCommands)
    for (const patch of [
      { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
      { projectId: 'prj_01JBBCDEF0123456789ABCDEFG' },
      { contextPackageId: contextPackageSerializationFixtures.futurePi.contextPackageId },
      { record: { ...storedCommand.record, scope: { ...scope, principalRef: 'service:other' } } },
    ]) {
      try {
        await isolated.application
          .update(contextAuthoringCommands)
          .set(patch)
          .where(eq(contextAuthoringCommands.commandKey, storedCommand.commandKey))
        await expect(repository.get(scope)).rejects.toThrow(
          'CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH'
        )
      } finally {
        await isolated.application
          .update(contextAuthoringCommands)
          .set(storedCommand)
          .where(eq(contextAuthoringCommands.commandKey, storedCommand.commandKey))
      }
    }

    const failedPackage = composeProviderContextPackage(candidates[0], {
      callerContextRefs: ['contract://rollback-input/v1'],
      localProjectGrantRefs: [],
      contributions: [],
    })
    const failedRecord = recordFor(failedPackage, 'context-authoring-rollback-0001')
    const failing = new PostgresContextAuthoringCommandRepository({
      transaction: (operation) =>
        isolated.application.transaction((transaction) =>
          operation({
            execute: transaction.execute.bind(transaction),
            select: transaction.select.bind(transaction),
            insert: (table) => {
              if (table === contextAuthoringCommands)
                throw new Error('INJECTED_COMMAND_WRITE_FAILURE')
              return transaction.insert(table)
            },
          })
        ),
    })
    await expect(failing.commit(failedRecord, failedPackage)).rejects.toThrow(
      'INJECTED_COMMAND_WRITE_FAILURE'
    )
    expect(await repository.get(failedRecord.scope)).toBeUndefined()
    expect(await packages.getById(failedPackage.contextPackageId)).toBeUndefined()
  })

  test('atomically retains validation results with concurrent connections and rejects corrupted metadata', async () => {
    await isolated.migrate()
    const plan = createExecutionPlanTestFixture({
      profileCapabilityRequirements: ['execution.cancel'],
    })
    const alternate = createExecutionPlanTestFixture({
      profileCapabilityRequirements: ['model.select'],
    })
    expect(alternate.executionPlanId).not.toBe(plan.executionPlanId)
    const scope = {
      callerPrincipalId: 'svc_agent-hq',
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      operation: 'execution.validate',
      idempotencyKey: 'validation-postgres-0001',
    }
    const recordFor = (value) => ({
      scope,
      commandId: ControlApiFixtures.executionValidation.request.commandId,
      requestId: value.correlation.requestId,
      payloadHash: executionValidationPayloadHash(ControlApiFixtures.executionValidation.request),
      executionPlan: { executionPlanId: value.executionPlanId, contentDigest: value.contentDigest },
      recordedAt: '2026-09-07T12:00:00.000Z',
    })
    const repository = new PostgresExecutionValidationCommandRepository(isolated.application)
    const plans = new PostgresExecutionPlanRepository(isolated.application)
    expect(await plans.get(recordFor(plan).executionPlan)).toBeUndefined()
    expect(await plans.get(recordFor(alternate).executionPlan)).toBeUndefined()
    const failing = new PostgresExecutionValidationCommandRepository({
      transaction: (operation) =>
        isolated.application.transaction((transaction) =>
          operation({
            execute: transaction.execute.bind(transaction),
            select: transaction.select.bind(transaction),
            insert: (table) => {
              if (table === executionValidationCommands)
                throw new Error('INJECTED_VALIDATION_WRITE_FAILURE')
              return transaction.insert(table)
            },
          })
        ),
    })
    await expect(failing.commit(recordFor(plan), plan)).rejects.toThrow(
      'INJECTED_VALIDATION_WRITE_FAILURE'
    )
    expect(await repository.get(scope)).toBeUndefined()
    expect(await plans.get(recordFor(plan).executionPlan)).toBeUndefined()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        const candidate = index % 2 ? alternate : plan
        return repository.commit(recordFor(candidate), candidate)
      })
    )
    for (const result of results) expect(result).toEqual(results[0])
    const loser =
      results[0].executionPlan.executionPlanId === plan.executionPlanId ? alternate : plan
    expect(await plans.get(recordFor(loser).executionPlan)).toBeUndefined()
    expect(await isolated.application.select().from(executionValidationCommands)).toHaveLength(1)
    expect(
      await new PostgresExecutionValidationCommandRepository(isolated.application).get(scope)
    ).toEqual(results[0])
    await expect(
      repository.commit({ ...recordFor(plan), payloadHash: `sha256:${'0'.repeat(64)}` }, plan)
    ).rejects.toThrow('EXECUTION_VALIDATION_COMMAND_CONFLICT')
    expect(await repository.get({ ...scope, callerPrincipalId: 'svc_other' })).toBeUndefined()
    const [stored] = await isolated.application.select().from(executionValidationCommands)
    for (const mutation of [
      { workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      { projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      { record: { ...stored.record, scope: { ...scope, callerPrincipalId: 'svc_other' } } },
      { record: { ...stored.record, requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV' } },
      {
        record: {
          ...stored.record,
          executionPlan: {
            ...stored.record.executionPlan,
            contentDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
      },
    ]) {
      try {
        await isolated.application
          .update(executionValidationCommands)
          .set(mutation)
          .where(eq(executionValidationCommands.commandKey, stored.commandKey))
        await expect(repository.get(scope)).rejects.toThrow()
      } finally {
        await isolated.application
          .update(executionValidationCommands)
          .set(stored)
          .where(eq(executionValidationCommands.commandKey, stored.commandKey))
      }
    }
    expect(await repository.get(scope)).toEqual(results[0])
  })

  test('persists workspace-scoped runtime discovery projections across restart', async () => {
    await isolated.migrate()
    const repository = new PostgresRuntimeDiscoveryRepository(isolated.application)
    const runtime = runtimeDiscoveryProjection()
    const session = externalSessionDiscoveryProjection()
    const scope = {
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      runtimeNodeRefId: runtime.node.runtimeNodeRefId,
    }
    await repository.putRuntimeConnection(scope.workspaceId, runtime)
    await repository.putExternalSession(scope, session)

    const restarted = new PostgresRuntimeDiscoveryRepository(isolated.application)
    expect(await restarted.listRuntimeConnections(scope)).toEqual([runtime])
    expect(await restarted.getRuntimeConnection(scope, runtime.runtimeConnectionId)).toEqual(
      runtime
    )
    expect(await restarted.listExternalSessions(scope)).toEqual([session])
    expect(await restarted.getExternalSession(scope, session.externalSessionId)).toEqual(session)
    expect(
      await restarted.listRuntimeConnections({
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
      })
    ).toEqual([])
    expect(await isolated.application.select().from(runtimeDiscoveryProjections)).toHaveLength(2)
    const next = {
      ...runtime,
      observedAt: new Date(Date.parse(runtime.observedAt) + 1_000).toISOString(),
    }
    expect(
      await restarted.compareAndSetRuntimeConnection(
        { ...scope, workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
        runtime,
        next
      )
    ).toBe(false)
    const updates = await Promise.all(
      Array.from({ length: 8 }, () =>
        new PostgresRuntimeDiscoveryRepository(isolated.application).compareAndSetRuntimeConnection(
          scope,
          runtime,
          next
        )
      )
    )
    expect(updates.filter(Boolean)).toHaveLength(1)
    expect(
      await restarted.compareAndSetRuntimeConnection(scope, runtime, {
        ...next,
        observedAt: new Date(Date.parse(next.observedAt) + 1_000).toISOString(),
      })
    ).toBe(false)
    expect(await restarted.getRuntimeConnection(scope, runtime.runtimeConnectionId)).toEqual(next)
    await expect(restarted.compareAndSetRuntimeConnection(scope, next, runtime)).rejects.toThrow(
      'RUNTIME_DISCOVERY_REFRESH_IDENTITY_MISMATCH'
    )
    await expect(
      restarted.compareAndSetRuntimeConnection(scope, next, {
        ...next,
        runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toThrow('RUNTIME_DISCOVERY_REFRESH_IDENTITY_MISMATCH')
  })

  test('persists immutable evaluation evidence across repository restart', async () => {
    await isolated.migrate()
    const run = {
      evalRunId: 'eval-run-integration',
      suite: {
        evalSuiteId: 'suite-release',
        version: 'v1',
        digest: `sha256:${'1'.repeat(64)}`,
        dataset: { id: 'dataset', version: 'v1', digest: `sha256:${'2'.repeat(64)}` },
        mode: 'offline',
        cases: [
          {
            evalCaseId: 'case-1',
            inputDigest: `sha256:${'3'.repeat(64)}`,
            scorers: [
              {
                metric: 'functional_correctness',
                direction: 'min',
                threshold: 0.9,
                required: true,
              },
            ],
          },
        ],
      },
      configuration: {
        executionPlanDigest: `sha256:${'4'.repeat(64)}`,
        profile: { id: 'profile', version: 'v1', digest: `sha256:${'5'.repeat(64)}` },
        skills: [],
        graph: { id: 'graph', version: 'v1', digest: `sha256:${'6'.repeat(64)}` },
        runtime: { id: 'runtime', version: 'v1', digest: `sha256:${'7'.repeat(64)}` },
        model: { id: 'model', version: 'v1', digest: `sha256:${'8'.repeat(64)}` },
        tools: [],
        policy: { id: 'policy', version: 'v1', digest: `sha256:${'9'.repeat(64)}` },
      },
      results: [],
      aggregateMetrics: { functional_correctness: 1 },
      status: 'passed',
      startedAt: '2026-08-25T12:00:00.000Z',
      completedAt: '2026-08-25T12:00:01.000Z',
    }
    run.results.push({
      evalCaseId: 'case-1',
      dataset: run.suite.dataset,
      configuration: run.configuration,
      metrics: { functional_correctness: 1 },
      failedRequiredMetrics: [],
      status: 'passed',
    })
    const repository = new PostgresEvaluationRepository(isolated.application)

    await repository.saveRun(run)
    await repository.saveRun(run)

    const restarted = new PostgresEvaluationRepository(isolated.application)
    expect(await restarted.getRun(run.evalRunId)).toEqual(run)
    expect(await isolated.application.select().from(evaluationRuns)).toHaveLength(1)
    const fixture = {
      taskId: 'case-1',
      version: '1',
      candidate: 'current',
      prompt: 'Inspect every gate.',
      untrustedSummary: '',
      requirements: [
        { id: 'gate', evidence: { id: 'run', candidate: 'current', outcome: 'pass' } },
      ],
    }
    const observed = await new EvaluationService({ repository }).run({
      evalRunId: 'eval-observed-integration',
      suite: {
        ...run.suite,
        cases: [{ ...run.suite.cases[0], inputDigest: evidenceAuditFixtureDigest(fixture) }],
      },
      configuration: run.configuration,
      execute: createEvidenceAuditMetricsExecutor({
        fixtures: [fixture],
        executorReference: 'scripted-pg-control-v1',
        seed: 1104,
        executor: async ({ tools }) => {
          const evidence = tools.inspect('gate')
          return {
            status: 'complete',
            requirements: [{ id: 'gate', evidenceId: evidence.id, state: 'verified' }],
          }
        },
      }),
    })
    const reconstructed = new PostgresEvaluationRepository(isolated.application)
    expect(await reconstructed.getRun(observed.evalRunId)).toEqual(observed)
    expect(observed.results[0].observation.observations).toHaveLength(1)
    const corrupted = structuredClone(observed)
    corrupted.results[0].observation.observations[0].target = 'forged'
    try {
      await isolated.application
        .update(evaluationRuns)
        .set({ evidence: corrupted })
        .where(eq(evaluationRuns.evalRunId, observed.evalRunId))
      await expect(reconstructed.getRun(observed.evalRunId)).rejects.toThrow()
    } finally {
      await isolated.application
        .update(evaluationRuns)
        .set({ evidence: observed })
        .where(eq(evaluationRuns.evalRunId, observed.evalRunId))
    }
    expect(await reconstructed.getRun(observed.evalRunId)).toEqual(observed)
  })

  test('persists immutable release decisions across repository restart', async () => {
    await isolated.migrate()
    const record = {
      releaseAuditId: 'f18f6f64-8d3a-7c11-b043-001122334455',
      releaseGateId: 'gate-profile-default',
      action: 'promote',
      actor: 'operator://release',
      toRunId: 'eval-run-integration',
      at: '2026-08-25T12:01:00.000Z',
    }
    const repository = new PostgresReleaseAuditRepository(isolated.application)

    await repository.append(record)
    await repository.append(record)
    const rollback = {
      ...record,
      releaseAuditId: '018f6f64-8d3a-7c11-b043-001122334456',
      action: 'rollback',
      actor: 'operator://incident',
      fromRunId: record.toRunId,
      toRunId: 'eval-run-baseline',
      reason: 'latency',
    }
    await repository.append(rollback)

    const restarted = new PostgresReleaseAuditRepository(isolated.application)
    expect(await restarted.list('gate-profile-default')).toEqual([record, rollback])
    expect(await isolated.application.select().from(releaseAuditRecords)).toHaveLength(2)
    await expect(restarted.append({ ...record, actor: 'operator://conflict' })).rejects.toThrow(
      'RELEASE_AUDIT_CONFLICT'
    )
  })

  test('persists idempotent runtime inventory and optimistic lifecycle updates', async () => {
    await isolated.migrate()
    const repository = new PostgresRuntimeConnectionRepository(isolated.application)
    const registry = new RuntimeConnectionRegistry(repository)
    const registration = {
      runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      identityDigest: `sha256:${'d'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      location: 'local_device',
      opaqueNativeRef: 'nref_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: [{ name: 'stream.output', support: 'supported' }],
      compatibilityState: 'compatible',
      limitations: [],
      lastDiscoveredAt: '2026-08-24T20:00:00.000Z',
      lastHeartbeatAt: '2026-08-24T20:00:00.000Z',
      lastHealthCheckAt: '2026-08-24T20:00:00.000Z',
      expiresAt: '2026-08-24T20:10:00.000Z',
    }
    const [first, replay] = await Promise.all([
      registry.register(registration),
      registry.register(registration),
    ])

    expect(replay).toEqual(first)
    expect(await registry.listByRuntimeNode(registration.runtimeNodeRefId)).toEqual([first])
    const update = {
      runtimeConnectionId: first.runtimeConnectionId,
      expectedVersion: first.version,
      observedAt: '2026-08-24T20:01:00.000Z',
      lastHeartbeatAt: '2026-08-24T20:01:00.000Z',
      status: 'degraded',
      health: 'degraded',
      compatibilityState: 'degraded',
    }
    const outcomes = await Promise.allSettled([
      registry.update(update),
      registry.update({ ...update, limitations: ['Concurrent health report'] }),
    ])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)

    const executionRepository = new PostgresExecutionRepository(isolated.application)
    const executionService = new ExecutionLifecycleService(executionRepository)
    const execution = await executionService.createExecution({
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAH',
      correlation: {
        workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAH',
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAH',
        taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAH',
        agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAH',
        requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAH',
      },
      executionPlan: {
        executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAH',
        contentDigest: `sha256:${'e'.repeat(64)}`,
        schemaVersion: 1,
      },
      acceptedAt: '2026-08-24T20:01:00.000Z',
    })
    const historicalAttempt = await executionService.createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAH',
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-24T20:01:30.000Z',
      runtime: { runtimeConnectionId: first.runtimeConnectionId },
    })
    const current = await registry.get(first.runtimeConnectionId)
    const revoked = await registry.revoke({
      runtimeConnectionId: first.runtimeConnectionId,
      expectedVersion: current.version,
      observedAt: '2026-08-24T20:02:00.000Z',
    })
    expect(revoked.status).toBe('revoked')
    expect(await executionRepository.getAttempt(historicalAttempt.attemptId)).toMatchObject({
      runtime: { runtimeConnectionId: revoked.runtimeConnectionId },
    })
    expect(await isolated.application.select().from(runtimeConnections)).toHaveLength(1)
    const query = { runtimeNodeRefId: registration.runtimeNodeRefId, limit: 2 }
    expect(await repository.scanByRuntimeNode(query)).toEqual([revoked])
    const added = []
    for (const index of [3, 1, 2, 4])
      added.push(
        await registry.register({
          ...registration,
          runtimeConnectionId: `rtc_01ZRZ3NDEKTSV4RRFFQ69G5FA${index}`,
          identityDigest: `sha256:${'f'.repeat(61)}00${index}`,
          runtimeNodeRefId:
            index === 4 ? 'rnr_01ZRZ3NDEKTSV4RRFFQ69G5FAV' : registration.runtimeNodeRefId,
        })
      )
    const page = await repository.scanByRuntimeNode({
      ...query,
      afterConnectionId: revoked.runtimeConnectionId,
    })
    expect(page).toEqual([added[1], added[2]])
    const restarted = new PostgresRuntimeConnectionRepository(isolated.application)
    const last = await restarted.scanByRuntimeNode({
      ...query,
      afterConnectionId: page[1].runtimeConnectionId,
    })
    expect(last).toEqual([added[0]])
    expect(
      await restarted.scanByRuntimeNode({
        ...query,
        afterConnectionId: last[0].runtimeConnectionId,
      })
    ).toEqual([])
    for (const invalid of [
      { ...query, limit: 0 },
      { ...query, limit: 129 },
      { ...query, afterConnectionId: 'bad' },
    ])
      await expect(restarted.scanByRuntimeNode(invalid)).rejects.toThrow()
  })

  test('fences channel generations across concurrent claims, release and repository restart', async () => {
    await isolated.migrate()
    const repository = new PostgresRuntimeChannelOwnershipRepository(isolated.application)
    const first = {
      nodeId: 'rnr_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: 'wsp_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      gatewayInstanceId: 'gateway-a',
      connectionId: 'connection-a',
      channelGeneration: 1,
      protocolVersion: { major: 1, minor: 6 },
      connectedAt: '2026-09-08T10:00:00.000Z',
      lastHeartbeatAt: '2026-09-08T10:00:00.000Z',
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new PostgresRuntimeChannelOwnershipRepository(isolated.application).claim(first)
      )
    )
    expect(results.filter(({ accepted }) => accepted)).toHaveLength(1)
    const second = {
      ...first,
      channelGeneration: 2,
      gatewayInstanceId: 'gateway-b',
      connectionId: 'connection-b',
    }
    expect(await repository.claim(second)).toEqual({ accepted: true, previous: first })
    expect(await repository.heartbeat(first)).toBe(false)
    expect(await repository.release(first)).toBe(false)
    expect(
      await repository.heartbeat({ ...second, workspaceId: 'wsp_01ERZ3NDEKTSV4RRFFQ69G5FAV' })
    ).toBe(false)
    const beat = { ...second, lastHeartbeatAt: '2026-09-08T10:00:15.000Z' }
    expect(await repository.heartbeat(beat)).toBe(true)
    expect(await repository.heartbeat(second)).toBe(false)
    expect(await repository.lookup(first.nodeId)).toEqual(beat)
    expect(await repository.release(second)).toBe(true)
    const restarted = new PostgresRuntimeChannelOwnershipRepository(isolated.application)
    expect(await restarted.lookup(first.nodeId)).toBeUndefined()
    expect(await restarted.claim(second)).toEqual({ accepted: false })
    await expect(
      restarted.claim({
        ...second,
        channelGeneration: 3,
        workspaceId: 'wsp_01ERZ3NDEKTSV4RRFFQ69G5FAV',
      })
    ).rejects.toThrow('RUNTIME_CHANNEL_WORKSPACE_MISMATCH')
    expect(await restarted.claim({ ...second, channelGeneration: 3 })).toEqual({ accepted: true })
  })

  test('persists inventory checkpoints across gateway restart with compare-and-set', async () => {
    await isolated.migrate()
    const repository = new PostgresRuntimeInventoryCheckpointRepository(isolated.application)
    const first = {
      runtimeNodeRefId: 'rnr_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: 'wsp_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      snapshotVersion: 1,
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      observedAt: '2026-08-25T12:00:00.000Z',
      activeRuntimeRefs: ['nref_01CRZ3NDEKTSV4RRFFQ69G5FAV'],
      revision: 1,
    }
    expect(await repository.compareAndSet(undefined, first)).toBe(true)
    expect(await repository.compareAndSet(undefined, first)).toBe(false)

    const restarted = new PostgresRuntimeInventoryCheckpointRepository(isolated.application)
    expect(await restarted.get(first.runtimeNodeRefId)).toEqual(first)
    const second = {
      ...first,
      snapshotVersion: 2,
      snapshotDigest: `sha256:${'b'.repeat(64)}`,
      observedAt: '2026-08-25T12:01:00.000Z',
      activeRuntimeRefs: [],
      revision: 2,
    }
    expect(await restarted.compareAndSet(1, second)).toBe(true)
    expect(await restarted.compareAndSet(1, { ...second, revision: 3 })).toBe(false)
    expect(await isolated.application.select().from(runtimeInventoryCheckpoints)).toHaveLength(1)
  })

  test('scans durable inventory with bounded cursor pages after repository recreation', async () => {
    await isolated.migrate()
    const repository = new PostgresRuntimeInventoryCheckpointRepository(isolated.application)
    const records = [3, 1, 2].map((index) => ({
      runtimeNodeRefId: `rnr_01ZRZ3NDEKTSV4RRFFQ69G5FA${index}`,
      workspaceId: 'wsp_01ZRZ3NDEKTSV4RRFFQ69G5FAV',
      snapshotVersion: 1,
      snapshotDigest: `sha256:${'b'.repeat(64)}`,
      observedAt: '2026-09-08T10:00:00.000Z',
      activeRuntimeRefs: [],
      revision: 1,
    }))
    for (const record of records)
      expect(await repository.compareAndSet(undefined, record)).toBe(true)
    const first = await repository.scan({ afterNodeId: 'rnr_01ZRZ3NDEKTSV4RRFFQ69G5FA0', limit: 2 })
    expect(first).toEqual([records[1], records[2]])
    const restarted = new PostgresRuntimeInventoryCheckpointRepository(isolated.application)
    const last = await restarted.scan({ afterNodeId: first[1].runtimeNodeRefId, limit: 2 })
    expect(last).toEqual([records[0]])
    expect(await restarted.scan({ afterNodeId: last[0].runtimeNodeRefId, limit: 2 })).toEqual([])
    for (const input of [{ limit: 0 }, { limit: 129 }, { limit: 1, afterNodeId: 'bad' }]) {
      await expect(restarted.scan(input)).rejects.toThrow()
    }
  })

  test('persists delegation lineage across service restart with compare-and-set', async () => {
    await isolated.migrate()
    const repository = new PostgresDelegationRepository(isolated.application)
    const record = {
      delegationId: 'dlg_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      delegationGroupId: 'dgr_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      parentExecutionId: 'exe_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      childExecutionId: 'exe_01MRZ3NDEKTSV4RRFFQ69G5FAW',
      childAttemptId: 'att_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      parentExecutionPlanId: 'pln_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      parentExecutionPlanDigest: `sha256:${'a'.repeat(64)}`,
      childExecutionPlanId: 'pln_01MRZ3NDEKTSV4RRFFQ69G5FAW',
      childExecutionPlanDigest: `sha256:${'b'.repeat(64)}`,
      contextPackageId: 'ctx_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      contextPackageDigest: `sha256:${'c'.repeat(64)}`,
      role: 'researcher',
      profileVersionId: 'pfv_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      objective: 'Durably research the bounded question',
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'retry',
        maximumRetries: 2,
      },
      state: 'dispatched',
      runtimeConnectionId: 'rtc_01MRZ3NDEKTSV4RRFFQ69G5FAV',
      retryCount: 0,
      inputDigest: `sha256:${'d'.repeat(64)}`,
      revision: 1,
      acceptedAt: '2026-08-25T18:00:00.000Z',
      deadlineAt: '2026-08-25T18:10:00.000Z',
      updatedAt: '2026-08-25T18:01:00.000Z',
    }
    expect(await repository.insert(record)).toBe(true)
    expect(await repository.insert(record)).toBe(false)

    const restarted = new PostgresDelegationRepository(isolated.application)
    expect(await restarted.get(record.delegationId)).toEqual(record)
    expect(await restarted.findByChild(record.childExecutionId)).toEqual(record)
    expect(await restarted.listByParent(record.parentExecutionId)).toEqual([record])

    const running = {
      ...record,
      state: 'running',
      revision: 2,
      updatedAt: '2026-08-25T18:02:00.000Z',
    }
    expect(await restarted.compareAndSet(1, running)).toBe(true)
    expect(await restarted.compareAndSet(1, { ...running, revision: 3 })).toBe(false)
    expect(await isolated.application.select().from(delegations)).toHaveLength(1)
  })

  test('persists runtime command delivery state across gateway repository restarts', async () => {
    await isolated.migrate()
    const runtimeConnectionId = 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAM'
    const nodeId = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAM'
    const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAM'
    const runtimeRegistry = new RuntimeConnectionRegistry(
      new PostgresRuntimeConnectionRepository(isolated.application)
    )
    await runtimeRegistry.register({
      runtimeConnectionId,
      identityDigest: `sha256:${'8'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: nodeId,
      runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      location: 'local_device',
      opaqueNativeRef: 'nref_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: [{ name: 'stream.output', support: 'supported' }],
      compatibilityState: 'compatible',
      limitations: [],
      lastDiscoveredAt: '2026-08-24T23:00:00.000Z',
      lastHeartbeatAt: '2026-08-24T23:00:00.000Z',
      lastHealthCheckAt: '2026-08-24T23:00:00.000Z',
    })
    const executionService = new ExecutionLifecycleService(
      new PostgresExecutionRepository(isolated.application)
    )
    const execution = await executionService.createExecution({
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      correlation: {
        workspaceId,
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAM',
        taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAM',
        agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAM',
        requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      },
      executionPlan: {
        executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAM',
        contentDigest: `sha256:${'7'.repeat(64)}`,
        schemaVersion: 1,
      },
      acceptedAt: '2026-08-24T23:00:00.000Z',
    })
    const attempt = await executionService.createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-24T23:00:01.000Z',
      runtime: { runtimeConnectionId },
    })
    const record = {
      commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      executionId: execution.executionId,
      attemptId: attempt.attemptId,
      nodeId,
      runtimeConnectionId,
      workspaceId,
      idempotencyKey: 'runtime-command:integration:1',
      payloadHash: `sha256:${'6'.repeat(64)}`,
      commandEnvelope: { type: 'command', payload: { operation: 'runtime.execute' } },
      issuedAt: '2026-08-24T23:00:01.000Z',
      expiresAt: '2026-08-24T23:05:01.000Z',
      status: 'queued',
      version: 1,
      deliveryAttempts: 0,
      createdAt: '2026-08-24T23:00:01.000Z',
      updatedAt: '2026-08-24T23:00:01.000Z',
    }
    const repository = new PostgresRuntimeCommandRepository(isolated.application)
    expect((await repository.create(record)).outcome).toBe('created')
    expect((await repository.create(record)).outcome).toBe('duplicate')

    const restarted = new PostgresRuntimeCommandRepository(isolated.application)
    expect(await restarted.listDispatchable(nodeId, '2026-08-24T23:00:02.000Z', 10)).toEqual([
      record,
    ])
    expect(await restarted.compareAndSet(1, { ...record, version: 2 })).toBe(true)
    expect(await restarted.compareAndSet(1, { ...record, version: 3 })).toBe(false)
    expect(await isolated.application.select().from(runtimeCommands)).toHaveLength(1)

    let currentExecution = await executionService.getExecution(execution.executionId)
    currentExecution = await executionService.transitionExecution({
      executionId: currentExecution.executionId,
      expectedVersion: currentExecution.version,
      to: 'queued',
      transitionedAt: '2026-08-24T23:00:01.000Z',
    })
    currentExecution = await executionService.transitionExecution({
      executionId: currentExecution.executionId,
      expectedVersion: currentExecution.version,
      to: 'running',
      transitionedAt: '2026-08-24T23:00:02.000Z',
    })
    let currentAttempt = await new PostgresExecutionRepository(isolated.application).getAttempt(
      attempt.attemptId
    )
    currentAttempt = await executionService.transitionAttempt({
      attemptId: currentAttempt.attemptId,
      expectedVersion: currentAttempt.version,
      to: 'running',
      transitionedAt: '2026-08-24T23:00:02.000Z',
    })
    const correlation = {
      ...currentExecution.correlation,
      commandId: record.commandId,
      traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAM',
    }
    const sink = new PostgresRuntimeEventEffectSink(isolated.application)
    const progress = {
      commandId: record.commandId,
      eventSequence: 1,
      frameHash: `sha256:${'5'.repeat(64)}`,
      draft: {
        eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAM',
        executionId: execution.executionId,
        attemptId: attempt.attemptId,
        type: 'attempt.progressed',
        schemaVersion: 1,
        correlation,
        payload: {
          state: 'running',
          privateKey: 'postgres-runtime-secret-canary-9f4a',
          nested: { signingKey: 'postgres-runtime-secret-canary-9f4a' },
        },
        occurredAt: '2026-08-24T23:00:02.000Z',
        recordedAt: '2026-08-24T23:00:03.000Z',
        retentionExpiresAt: '2026-11-22T23:00:03.000Z',
      },
    }
    expect(await sink.applyProgress(progress)).toMatchObject({
      outcome: 'applied',
      event: {
        payload: {
          state: 'running',
          privateKey: '[REDACTED]',
          nested: { signingKey: '[REDACTED]' },
        },
      },
    })
    expect(
      await new PostgresRuntimeEventEffectSink(isolated.application).applyProgress(progress)
    ).toMatchObject({ outcome: 'duplicate' })
    const laterProgress = {
      ...progress,
      eventSequence: 3,
      frameHash: `sha256:${'3'.repeat(64)}`,
      draft: {
        ...progress.draft,
        eventId: 'evt_01CRZ3NDEKTSV4RRFFQ69G5FAM',
        payload: { state: 'running', checkpoint: 3 },
      },
    }
    expect(await sink.applyProgress(laterProgress)).toMatchObject({ outcome: 'applied' })
    expect(
      await sink.applyProgress({
        ...progress,
        eventSequence: 2,
        frameHash: `sha256:${'2'.repeat(64)}`,
        draft: { ...progress.draft, eventId: 'evt_01DRZ3NDEKTSV4RRFFQ69G5FAM' },
      })
    ).toEqual({ outcome: 'out_of_order' })
    expect(
      await sink.applyProgress({ ...progress, frameHash: `sha256:${'1'.repeat(64)}` })
    ).toEqual({ outcome: 'conflict' })
    const terminal = {
      commandId: record.commandId,
      messageSequence: 2,
      frameHash: `sha256:${'4'.repeat(64)}`,
      execution: currentExecution,
      attempt: currentAttempt,
      state: 'completed',
      resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAM',
      draft: {
        eventId: 'evt_01BRZ3NDEKTSV4RRFFQ69G5FAM',
        executionId: execution.executionId,
        attemptId: attempt.attemptId,
        type: 'execution.completed',
        schemaVersion: 1,
        correlation,
        payload: { usage: { outputTokens: 2 } },
        occurredAt: '2026-08-24T23:00:04.000Z',
        recordedAt: '2026-08-24T23:00:04.000Z',
        retentionExpiresAt: '2026-11-22T23:00:04.000Z',
      },
    }
    const cancelRecord = {
      ...record,
      commandId: 'cmd_01BRZ3NDEKTSV4RRFFQ69G5FAM',
      idempotencyKey: 'runtime-command:integration:cancel',
      payloadHash: `sha256:${'9'.repeat(64)}`,
      commandEnvelope: { type: 'command', payload: { operation: 'runtime.cancel' } },
      status: 'dispatched',
      deliveryAttempts: 1,
      lastChannelGeneration: 1,
      lastSequence: 10,
      firstDispatchedAt: '2026-08-24T23:00:03.000Z',
      lastDispatchedAt: '2026-08-24T23:00:03.000Z',
      updatedAt: '2026-08-24T23:00:03.000Z',
    }
    expect((await repository.create(cancelRecord)).outcome).toBe('created')
    const cancelledTerminal = {
      ...terminal,
      commandId: cancelRecord.commandId,
      messageSequence: 11,
      frameHash: `sha256:${'8'.repeat(64)}`,
      state: 'cancelled',
      resultReference: undefined,
      draft: {
        ...terminal.draft,
        eventId: 'evt_01ERZ3NDEKTSV4RRFFQ69G5FAM',
        type: 'execution.cancelled',
        correlation: { ...correlation, commandId: cancelRecord.commandId },
        payload: { reason: 'user_requested' },
      },
    }
    const effects = [terminal, cancelledTerminal]
    const terminalOutcomes = await Promise.all(effects.map((effect) => sink.applyTerminal(effect)))
    expect(terminalOutcomes.map(({ outcome }) => outcome).sort()).toEqual([
      'applied',
      'terminal_conflict',
    ])
    const winner = effects[terminalOutcomes.findIndex(({ outcome }) => outcome === 'applied')]
    expect(
      await new PostgresRuntimeEventEffectSink(isolated.application).applyTerminal(winner)
    ).toMatchObject({ outcome: 'duplicate' })
    expect(await isolated.application.select().from(runtimeCommands)).toHaveLength(2)
    expect(await isolated.application.select().from(runtimeEventReceipts)).toHaveLength(5)
    expect(await isolated.application.select().from(executionEvents)).toHaveLength(3)
    expect(await executionService.getExecution(execution.executionId)).toMatchObject({
      state: winner.state,
      ...(winner.resultReference ? { terminalResultRef: winner.resultReference } : {}),
    })
    const eventService = new ExecutionEventService(
      new PostgresExecutionEventRepository(isolated.application)
    )
    for (const event of await isolated.application.select().from(executionEvents)) {
      if (event.executionId !== execution.executionId) continue
      await eventService.markPublished({
        eventId: event.eventId,
        expectedPublicationVersion: event.publicationVersion,
        publishedAt: '2026-08-24T23:00:05.000Z',
      })
    }
  })

  test('persists versioned health ingestion and freshness across service restarts', async () => {
    const repository = new PostgresRuntimeConnectionRepository(isolated.application)
    const registry = new RuntimeConnectionRegistry(repository)
    const runtimeConnectionId = 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAJ'
    await registry.register({
      runtimeConnectionId,
      identityDigest: `sha256:${'f'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAJ',
      runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAJ',
      location: 'local_device',
      opaqueNativeRef: 'nref_01ARZ3NDEKTSV4RRFFQ69G5FAJ',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: [],
      compatibilityState: 'untested',
      limitations: [],
      lastDiscoveredAt: '2026-08-24T21:00:00.000Z',
      lastHeartbeatAt: '2026-08-24T21:00:00.000Z',
      lastHealthCheckAt: '2026-08-24T21:00:00.000Z',
    })
    const policy = {
      adapterMajor: 1,
      driverMajor: 1,
      harnessMajor: 1,
      protocolMajor: 1,
      healthTtlMs: 60_000,
      maximumCapabilityTtlMs: 60_000,
    }
    const report = {
      runtimeConnectionId,
      reportSequence: 1,
      observedAt: '2026-08-24T21:01:00.000Z',
      discoveredAt: '2026-08-24T21:00:30.000Z',
      nodeStatus: 'online',
      runtimeState: 'healthy',
      versions: {
        adapter: '1.0.0',
        driver: '1.0.0',
        harness: '1.0.0',
        protocol: '1.0.0',
      },
      capabilitySnapshot: {
        version: 1,
        observedAt: '2026-08-24T21:01:00.000Z',
        ttlMs: 60_000,
        verification: 'verified',
        source: 'adapter_driver_negotiation',
        capabilities: [{ name: 'stream.output', support: 'supported' }],
      },
      limitations: [],
      diagnostics: [],
    }
    const readPending = () =>
      isolated.application
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, runtimeConnectionId))
    const failing = new PostgresRuntimeHealthIngestionService(
      {
        transaction: (operation) =>
          isolated.application.transaction((transaction) =>
            operation(
              new Proxy(transaction, {
                get(target, property) {
                  if (property === 'insert')
                    return (table) => {
                      if (table === outboxEvents) throw new Error('OUTBOX_UNAVAILABLE')
                      return target.insert(table)
                    }
                  const value = Reflect.get(target, property)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              })
            )
          ),
      },
      policy
    )
    await expect(failing.ingest(report, '2026-08-24T21:01:10.000Z')).rejects.toThrow(
      'OUTBOX_UNAVAILABLE'
    )
    expect((await registry.get(runtimeConnectionId)).lastHealthReportSequence).toBeUndefined()
    expect(await readPending()).toHaveLength(0)
    const ingestion = new PostgresRuntimeHealthIngestionService(isolated.application, policy)
    const healthy = await ingestion.ingest(report, '2026-08-24T21:01:10.000Z')
    expect(healthy.connection).toMatchObject({
      availabilityState: 'healthy',
      protocolVersion: '1.0.0',
      capabilitySnapshotVersion: 1,
      capabilityVerification: 'verified',
      lastHealthReportSequence: 1,
      lastDiscoveredAt: '2026-08-24T21:00:30.000Z',
    })
    expect(await readPending()).toHaveLength(1)

    const restarted = new PostgresRuntimeHealthIngestionService(isolated.application, policy)
    expect(await restarted.ingest(report, '2026-08-24T21:01:20.000Z')).toMatchObject({
      applied: false,
      reason: 'replayed_report',
    })
    expect(await readPending()).toHaveLength(1)
    await expect(
      failing.refresh({
        runtimeConnectionId,
        nodeStatus: 'offline',
        evaluatedAt: '2026-08-24T21:02:01.000Z',
      })
    ).rejects.toThrow('OUTBOX_UNAVAILABLE')
    expect((await registry.get(runtimeConnectionId)).availabilityState).toBe('healthy')
    expect(await readPending()).toHaveLength(1)
    const stale = await restarted.refresh({
      runtimeConnectionId,
      nodeStatus: 'offline',
      evaluatedAt: '2026-08-24T21:02:01.000Z',
    })
    expect(stale).toMatchObject({
      applied: true,
      connection: { availabilityState: 'stale', status: 'unavailable' },
      assessment: {
        nodeStatus: 'offline',
        executable: false,
        diagnostics: expect.arrayContaining(['CAPABILITY_SNAPSHOT_STALE', 'NODE_OFFLINE']),
      },
    })
    const pending = await readPending()
    expect(pending).toHaveLength(2)
    expect(pending.every((row) => row.status === 'pending')).toBe(true)
    expect(pending.map((row) => row.payload.currentState).sort()).toEqual(['healthy', 'stale'])
    expect(
      await restarted.refresh({
        runtimeConnectionId,
        nodeStatus: 'offline',
        evaluatedAt: '2026-08-24T21:02:02.000Z',
      })
    ).toMatchObject({ reason: 'already_current' })
    expect(await readPending()).toHaveLength(2)
    const readApplied = () =>
      isolated.application
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateType, 'm11-health-consumer-effect'))
    const deliveries = []
    const envelopes = []
    let exitedConsumer
    let loseAcknowledgement = true
    const transport = {
      async deliver(event) {
        deliveries.push(event.deliveryKey)
        envelopes.push(structuredClone(event))
        if (loseAcknowledgement) {
          loseAcknowledgement = false
          const applicationUrl = new URL(loadDatabaseCredentials(process.env, 'application').url)
          applicationUrl.pathname = `/${isolated.name}`
          exitedConsumer = spawnSync(
            process.execPath,
            [
              '-e',
              `
            import { createPostgresConnection } from ${JSON.stringify(new URL('./connection.ts', import.meta.url).href)};
            import { acceptRuntimeHealthFixture } from ${JSON.stringify(new URL('./runtime-health-consumer-fixture.mjs', import.meta.url).href)};
            const connection = createPostgresConnection({ role: 'application', url: process.env.TEST_APPLICATION_URL });
            await acceptRuntimeHealthFixture(connection.database, JSON.parse(process.env.TEST_HEALTH_EVENT));
            process.exit(73);
          `,
            ],
            {
              cwd: fileURLToPath(new URL('..', import.meta.url)),
              env: {
                PATH: process.env.PATH,
                TEST_APPLICATION_URL: applicationUrl.toString(),
                TEST_HEALTH_EVENT: JSON.stringify(event),
              },
              encoding: 'utf8',
              timeout: 10_000,
            }
          )
          throw new Error('ACK_LOST')
        }
        return acceptRuntimeHealthFixture(isolated.application, event)
      },
    }
    let deliveryNow = Date.now()
    const deliveryClock = () => new Date(deliveryNow)
    const dispatcher = new PostgresRuntimeHealthEventDispatcher(
      isolated.application,
      transport,
      deliveryClock
    )
    const firstDispatch = dispatcher.dispatchBatch(1)
    expect(dispatcher.dispatchBatch(1)).toBe(firstDispatch)
    expect(await firstDispatch).toEqual({ delivered: 0, failed: 1, conflicts: 0 })
    expect(exitedConsumer.error).toBeUndefined()
    expect(exitedConsumer.signal).toBeNull()
    expect(exitedConsumer.status).toBe(73)
    expect(exitedConsumer.stdout).toBe('')
    expect(await readApplied()).toHaveLength(1)
    expect((await readPending()).filter((row) => row.status === 'failed')).toHaveLength(1)
    const recreatedDispatcher = new PostgresRuntimeHealthEventDispatcher(
      isolated.application,
      transport,
      deliveryClock
    )
    expect((await readPending()).filter((row) => row.status === 'failed')[0].nextAttemptAt).toEqual(
      new Date(deliveryNow + 1_000)
    )
    // The other pending event remains eligible, but the failed event is not due yet.
    expect(await recreatedDispatcher.dispatchBatch(128)).toEqual({
      delivered: 1,
      failed: 0,
      conflicts: 0,
    })
    deliveryNow += 999
    expect(await recreatedDispatcher.dispatchBatch(128)).toEqual({
      delivered: 0,
      failed: 0,
      conflicts: 0,
    })
    deliveryNow += 1
    expect(await recreatedDispatcher.dispatchBatch(128)).toEqual({
      delivered: 1,
      failed: 0,
      conflicts: 0,
    })
    expect(await readApplied()).toHaveLength(2)
    const duplicateReceipts = await Promise.all(
      Array.from({ length: 8 }, () =>
        acceptRuntimeHealthFixture(isolated.application, envelopes[0])
      )
    )
    expect(
      duplicateReceipts.every((receipt) => receipt.acceptedDeliveryKey === envelopes[0].deliveryKey)
    ).toBe(true)
    await expect(
      acceptRuntimeHealthFixture(isolated.application, {
        ...envelopes[0],
        change: { ...envelopes[0].change, diagnostics: ['NODE_OFFLINE'] },
      })
    ).rejects.toThrow('HEALTH_DELIVERY_KEY_CONFLICT')
    expect(await readApplied()).toHaveLength(2)
    expect(deliveries).toHaveLength(3)
    expect(new Set(deliveries).size).toBe(2)
    expect((await readPending()).every((row) => row.status === 'published')).toBe(true)
    expect(await recreatedDispatcher.dispatchBatch(128)).toEqual({
      delivered: 0,
      failed: 0,
      conflicts: 0,
    })
    for (const limit of [0, -1, 1.5, 129])
      expect(() => recreatedDispatcher.dispatchBatch(limit)).toThrow(
        'INVALID_RUNTIME_HEALTH_DISPATCH_LIMIT'
      )
    await restarted.ingest(
      {
        ...report,
        reportSequence: 2,
        observedAt: '2026-08-24T21:03:00.000Z',
        capabilitySnapshot: {
          ...report.capabilitySnapshot,
          version: 2,
          observedAt: '2026-08-24T21:03:00.000Z',
        },
      },
      '2026-08-24T21:03:01.000Z'
    )
    let deliverySignal
    const hung = new PostgresRuntimeHealthEventDispatcher(
      isolated.application,
      {
        deliver(_event, signal) {
          deliverySignal = signal
          return new Promise(() => {})
        },
      },
      deliveryClock,
      10
    )
    expect(await hung.dispatchBatch(1)).toEqual({ delivered: 0, failed: 1, conflicts: 0 })
    expect(deliverySignal.aborted).toBe(true)
    deliveryNow += 1_000
    const wrongAck = new PostgresRuntimeHealthEventDispatcher(
      isolated.application,
      {
        async deliver() {
          return { acceptedDeliveryKey: 'wrong-key' }
        },
      },
      deliveryClock
    )
    expect(await wrongAck.dispatchBatch(1)).toEqual({ delivered: 0, failed: 1, conflicts: 0 })
    expect(await recreatedDispatcher.dispatchBatch(1)).toEqual({
      delivered: 0,
      failed: 0,
      conflicts: 0,
    })
    deliveryNow += 2_000
    expect(await recreatedDispatcher.dispatchBatch(1)).toEqual({
      delivered: 1,
      failed: 0,
      conflicts: 0,
    })
    expect(await readApplied()).toHaveLength(3)
    expect((await readPending()).every((row) => row.status === 'published')).toBe(true)
    await isolated.application.insert(outboxEvents).values({
      aggregateType: 'runtime_connection',
      aggregateId: runtimeConnectionId,
      eventType: 'runtime.availability_changed',
      payload: envelopes[0].change,
    })
    const exhausted = new PostgresRuntimeHealthEventDispatcher(
      isolated.application,
      {
        async deliver() {
          throw new Error('OFFLINE')
        },
      },
      deliveryClock,
      10_000,
      { maximumAttempts: 2 }
    )
    expect(await exhausted.dispatchBatch(1)).toEqual({ delivered: 0, failed: 1, conflicts: 0 })
    deliveryNow += 1_000
    expect(await exhausted.dispatchBatch(1)).toEqual({ delivered: 0, failed: 1, conflicts: 0 })
    const quarantined = (await readPending()).filter((row) => row.quarantinedAt !== null)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      nextAttemptAt: null,
      quarantinedAt: new Date(deliveryNow),
    })
    deliveryNow += 86_400_000
    expect(await recreatedDispatcher.dispatchBatch(128)).toEqual({
      delivered: 0,
      failed: 0,
      conflicts: 0,
    })
    const deliveryCount = deliveries.length
    await isolated.application.insert(outboxEvents).values([
      {
        aggregateType: 'runtime_connection',
        aggregateId: runtimeConnectionId,
        eventType: 'runtime.availability_changed',
        payload: {},
      },
      {
        aggregateType: 'runtime_connection',
        aggregateId: 'wrong-runtime',
        eventType: 'runtime.availability_changed',
        payload: envelopes[0].change,
      },
    ])
    expect(await recreatedDispatcher.dispatchBatch(128)).toEqual({
      delivered: 0,
      failed: 2,
      conflicts: 0,
    })
    expect(deliveries).toHaveLength(deliveryCount)
    for (const retry of [
      { baseDelayMs: 0 },
      { baseDelayMs: 60_001 },
      { maximumAttempts: 0 },
      { maximumAttempts: 101 },
      { maximumAttempts: 1.5 },
    ])
      expect(
        () =>
          new PostgresRuntimeHealthEventDispatcher(
            isolated.application,
            transport,
            deliveryClock,
            10_000,
            retry
          )
      ).toThrow('INVALID_RUNTIME_HEALTH_RETRY_POLICY')
    for (const timeout of [0, -1, 1.5, 60_001])
      expect(
        () =>
          new PostgresRuntimeHealthEventDispatcher(
            isolated.application,
            transport,
            undefined,
            timeout
          )
      ).toThrow('INVALID_RUNTIME_HEALTH_DISPATCH_TIMEOUT')
  })

  test('persists scoped external session references without native ownership transfer', async () => {
    await isolated.migrate()
    const runtimeConnectionId = 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAK'
    const runtimeRegistry = new RuntimeConnectionRegistry(
      new PostgresRuntimeConnectionRepository(isolated.application)
    )
    await runtimeRegistry.register({
      runtimeConnectionId,
      identityDigest: `sha256:${'9'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      location: 'local_device',
      opaqueNativeRef: 'nref_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: [{ name: 'session.resume', support: 'supported' }],
      compatibilityState: 'compatible',
      limitations: [],
      lastDiscoveredAt: '2026-08-24T22:00:00.000Z',
      lastHeartbeatAt: '2026-08-24T22:00:00.000Z',
      lastHealthCheckAt: '2026-08-24T22:00:00.000Z',
    })
    const registry = new ExternalSessionRegistry(
      new PostgresExternalSessionRepository(isolated.application)
    )
    const session = await registry.register({
      externalSessionId: 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      runtimeConnectionId,
      opaqueNativeSessionId: 'nses_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAK',
      state: 'active',
      ownership: {
        authority: 'external_runtime',
        imported: false,
        concurrentNativeUse: 'allowed',
      },
      capabilitySnapshot: {
        version: 1,
        observedAt: '2026-08-24T22:00:00.000Z',
        expiresAt: '2026-08-24T22:01:00.000Z',
        operations: ['session.resume'],
      },
      safeMetadata: {
        origin: 'native_discovery',
        displayName: 'Native planning session',
        limitations: [],
      },
      lastObservedAt: '2026-08-24T22:00:00.000Z',
    })
    const restarted = new ExternalSessionRegistry(
      new PostgresExternalSessionRepository(isolated.application)
    )
    expect(
      await restarted.list({
        workspaceId: session.workspaceId,
        projectId: session.projectId,
        runtimeConnectionId,
      })
    ).toEqual([session])
    const removed = await restarted.update({
      externalSessionId: session.externalSessionId,
      expectedVersion: session.version,
      observedAt: '2026-08-24T22:00:30.000Z',
      state: 'removed',
    })
    expect(removed).toMatchObject({ state: 'removed', version: 2 })
    expect(await isolated.application.select().from(externalSessions)).toHaveLength(1)
    expect(JSON.stringify(removed)).not.toContain('/Users/')
    expect(JSON.stringify(removed)).not.toContain('credential')
  })

  test('persists lifecycle transitions and multiple runtime attempts with optimistic concurrency', async () => {
    const repository = new PostgresExecutionRepository(isolated.application)
    const service = new ExecutionLifecycleService(repository)
    const execution = await service.createExecution({
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      correlation: {
        workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      executionPlan: {
        executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        schemaVersion: 1,
      },
      acceptedAt: '2026-08-23T10:00:00.000Z',
      deadlineAt: '2026-08-23T11:00:00.000Z',
    })
    const firstAttempt = await service.createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-23T10:01:00.000Z',
      runtime: {
        runtimeDefinitionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        routingDecision: {
          routingVersion: 1,
          policy: {
            policyId: 'runtime-standard',
            version: 1,
            digest: `sha256:${'b'.repeat(64)}`,
          },
          evaluatedAt: '2026-08-23T10:00:59.000Z',
          inputDigest: `sha256:${'c'.repeat(64)}`,
          decisionDigest: `sha256:${'d'.repeat(64)}`,
          selectedRank: 1,
          candidateCount: 2,
          reasonCodes: ['HEALTH', 'LOCALITY'],
        },
      },
    })
    const afterFirst = await service.getExecution(execution.executionId)
    const secondAttempt = await service.createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      expectedExecutionVersion: afterFirst.version,
      queuedAt: '2026-08-23T10:02:00.000Z',
    })

    expect(firstAttempt.sequence).toBe(1)
    expect(await repository.getAttempt(firstAttempt.attemptId)).toMatchObject({
      runtime: {
        runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        routingDecision: {
          routingVersion: 1,
          policy: { policyId: 'runtime-standard', version: 1 },
          selectedRank: 1,
          candidateCount: 2,
        },
      },
    })
    expect(secondAttempt.sequence).toBe(2)
    expect(await repository.listAttempts(execution.executionId)).toHaveLength(2)
    expect(await service.getExecution(execution.executionId)).toMatchObject({
      version: 3,
      attemptCount: 2,
      latestAttemptId: secondAttempt.attemptId,
    })

    const outcomes = await Promise.allSettled([
      service.transitionAttempt({
        attemptId: secondAttempt.attemptId,
        expectedVersion: secondAttempt.version,
        to: 'starting',
        transitionedAt: '2026-08-23T10:03:00.000Z',
      }),
      service.transitionAttempt({
        attemptId: secondAttempt.attemptId,
        expectedVersion: secondAttempt.version,
        to: 'running',
        transitionedAt: '2026-08-23T10:03:00.000Z',
      }),
    ])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  })

  test('persists reconciliation checkpoints and replays the decision without repeating effects', async () => {
    const acceptance = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => 'exe_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      executionPlanValidator: { validate: async () => true },
    })
    const { execution } = await acceptance.acceptExecution({
      callerPrincipalId: 'svc_agent-hq',
      operation: 'execution.accept',
      commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      idempotencyKey: 'reconciliation-integration',
      payloadHash: '8'.repeat(64),
      correlation: {
        workspaceId: 'wsp_01DRZ3NDEKTSV4RRFFQ69G5FAV',
        projectId: 'prj_01DRZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: 'tsk_01DRZ3NDEKTSV4RRFFQ69G5FAV',
        agentId: 'agt_01DRZ3NDEKTSV4RRFFQ69G5FAV',
      },
      executionPlan: {
        executionPlanId: 'pln_01DRZ3NDEKTSV4RRFFQ69G5FAV',
        contentDigest: `sha256:${'7'.repeat(64)}`,
        schemaVersion: 1,
      },
      receivedAt: '2026-08-24T14:00:00.000Z',
      retentionExpiresAt: '2026-09-24T14:00:00.000Z',
    })
    const observation = {
      executionId: execution.executionId,
      checkedAt: '2026-08-24T15:00:00.000Z',
      command: { status: 'accepted', commandId: 'cmd_01DRZ3NDEKTSV4RRFFQ69G5FAV' },
      execution: { state: 'accepted', updatedAt: execution.updatedAt },
      workflow: { status: 'missing' },
      runtime: { status: 'unknown', observedAt: '2026-08-24T15:00:00.000Z' },
      delivery: { pendingCount: 0 },
    }
    const effects = []
    const options = {
      repository: new PostgresReconciliationCheckpointRepository(isolated.application),
      source: {
        load: async () => observation,
        listCandidates: async () => [execution.executionId],
      },
      effects: {
        markReconciliationRequired: async (input) => effects.push(['mark', input]),
        resumeWorkflow: async (input) => effects.push(['resume', input]),
        applyRuntimeTerminal: async (input) => effects.push(['terminal', input]),
        replayEvents: async (input) => effects.push(['replay', input]),
      },
    }

    const first = await new ExecutionReconciliationService(options).reconcile(execution.executionId)
    const replay = await new ExecutionReconciliationService(options).reconcile(
      execution.executionId
    )

    expect(replay).toEqual(first)
    expect(effects.map(([kind]) => kind)).toEqual(['mark', 'resume'])
    expect(
      await isolated.application
        .select()
        .from(reconciliationCheckpoints)
        .where(eq(reconciliationCheckpoints.executionId, execution.executionId))
    ).toHaveLength(1)
  })

  test('retired command keys prevent PostgreSQL readmission after receipt removal', async () => {
    const now = '2026-08-24T11:00:00.000Z'
    const retiredAt = '2026-09-24T11:00:00.000Z'
    const suffix = '01CRZ3NDEKTSV4RRFFQ69G5FAW'
    const repository = new PostgresCommandAcceptanceRepository(isolated.application)
    const service = new CommandInboxService({
      repository,
      executionIdFactory: () => `exe_${suffix}`,
      executionPlanValidator: { validate: async () => true },
      now: () => now,
    })
    const input = {
      callerPrincipalId: 'svc_retention-test',
      operation: 'execution.accept',
      commandId: `cmd_${suffix}`,
      requestId: `req_${suffix}`,
      idempotencyKey: 'integration-retirement-1',
      payloadHash: 'a'.repeat(64),
      correlation: {
        workspaceId: `wsp_${suffix}`,
        projectId: `prj_${suffix}`,
        taskId: `tsk_${suffix}`,
        agentId: `agt_${suffix}`,
      },
      executionPlan: {
        executionPlanId: `pln_${suffix}`,
        contentDigest: `sha256:${'b'.repeat(64)}`,
        schemaVersion: 1,
      },
      receivedAt: now,
      retentionExpiresAt: '2026-09-23T11:00:00.000Z',
    }
    const accepted = await service.acceptExecution(input)
    expect(await repository.retireExpiredCommand(accepted.command, retiredAt)).toBe(false)
    expect(
      await repository.compareAndSet(1, {
        ...accepted.command,
        status: 'failed',
        terminalAt: now,
        errorReference: 'error://test/cancelled',
        version: 2,
      })
    ).toBe(true)
    expect(await repository.retireExpiredCommand(accepted.command, retiredAt)).toBe(false)
    await isolated.application
      .update(executions)
      .set({ state: 'cancelled', terminalAt: new Date(now) })
      .where(eq(executions.executionId, accepted.execution.executionId))
    expect(await repository.retireExpiredCommand(accepted.command, input.retentionExpiresAt)).toBe(
      false
    )
    expect(
      await Promise.all(
        Array.from({ length: 8 }, () =>
          new PostgresCommandAcceptanceRepository(isolated.application).retireExpiredCommand(
            accepted.command,
            retiredAt
          )
        )
      )
    ).toEqual(Array(8).fill(true))
    // Simulate future dependency-aware payload cleanup only in the isolated test database.
    await isolated.application
      .delete(commandInbox)
      .where(eq(commandInbox.commandId, input.commandId))
    const restarted = new PostgresCommandAcceptanceRepository(isolated.application)
    await expect(restarted.get(accepted.command)).rejects.toMatchObject({
      code: 'COMMAND_RETENTION_EXPIRED',
    })
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        restarted.accept({ ...accepted.command, payloadHash: 'c'.repeat(64) }, accepted.execution)
      )
    )
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'COMMAND_RETENTION_EXPIRED'
      )
    ).toBe(true)
    await expect(
      new CommandInboxService({
        repository: restarted,
        executionIdFactory: () => {
          throw new Error('MUST_NOT_ALLOCATE')
        },
        executionPlanValidator: { validate: async () => true },
        now: () => retiredAt,
      }).acceptExecution({
        ...input,
        commandId: 'cmd_01CRZ3NDEKTSV4RRFFQ69G5FAX',
        receivedAt: retiredAt,
        retentionExpiresAt: '2026-11-24T11:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'COMMAND_RETENTION_EXPIRED' })
    expect(
      await restarted.get({ ...accepted.command, callerPrincipalId: 'svc_other' })
    ).toBeUndefined()
    expect(
      await restarted.get({ ...accepted.command, projectId: 'prj_01CRZ3NDEKTSV4RRFFQ69G5FAX' })
    ).toBeUndefined()
    const [tombstone] = await isolated.application
      .select()
      .from(retiredCommandKeys)
      .where(eq(retiredCommandKeys.commandId, input.commandId))
    expect(tombstone).toEqual({
      scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      commandId: input.commandId,
      executionId: accepted.execution.executionId,
      retiredAt: new Date(retiredAt),
    })
  })

  test('recovers a committed command after the accepting process exits before replying', async () => {
    const suffix = '01ZRZ3NDEKTSV4RRFFQ69G5FAV'
    const input = {
      callerPrincipalId: 'svc_agent-hq',
      operation: 'execution.accept',
      commandId: `cmd_${suffix}`,
      requestId: `req_${suffix}`,
      idempotencyKey: 'integration-process-exit',
      payloadHash: 'a'.repeat(64),
      correlation: {
        workspaceId: `wsp_${suffix}`,
        projectId: `prj_${suffix}`,
        taskId: `tsk_${suffix}`,
        agentId: `agt_${suffix}`,
      },
      executionPlan: {
        executionPlanId: `pln_${suffix}`,
        contentDigest: `sha256:${'b'.repeat(64)}`,
        schemaVersion: 1,
      },
      receivedAt: '2026-08-24T11:00:00.000Z',
      retentionExpiresAt: '2026-09-23T11:00:00.000Z',
    }
    const applicationUrl = new URL(loadDatabaseCredentials(process.env, 'application').url)
    applicationUrl.pathname = `/${isolated.name}`
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      import { CommandInboxService } from '@control-plane/domain';
      import { createPostgresConnection } from ${JSON.stringify(new URL('./connection.ts', import.meta.url).href)};
      import { PostgresCommandAcceptanceRepository } from ${JSON.stringify(new URL('./command-inbox-repository.ts', import.meta.url).href)};
      const connection = createPostgresConnection({ role: 'application', url: process.env.TEST_APPLICATION_URL });
      const service = new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(connection.database),
        executionIdFactory: () => ${JSON.stringify(`exe_${suffix}`)},
        executionPlanValidator: { validate: async () => true },
        now: () => ${JSON.stringify(input.receivedAt)},
        failureInjector: { checkpoint(name) { if (name === 'control_api.after_accept') process.exit(73); } },
      });
      await service.acceptExecution(${JSON.stringify(input)});
      console.log('UNEXPECTED_ACCEPTANCE_REPLY');
    `,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, TEST_APPLICATION_URL: applicationUrl.toString() },
        encoding: 'utf8',
        timeout: 10_000,
      }
    )
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(73)
    expect(child.stdout).toBe('')
    const recovered = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => {
        throw new Error('REPLAY_MUST_NOT_ALLOCATE')
      },
      executionPlanValidator: {
        validate: async () => {
          throw new Error('REPLAY_MUST_NOT_REVALIDATE')
        },
      },
      now: () => input.receivedAt,
    })
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recovered.acceptExecution(input))
    )
    expect(results.every((result) => result.replayed)).toBe(true)
    expect(results.every((result) => result.command.commandId === input.commandId)).toBe(true)
    expect(results.every((result) => result.execution.executionId === `exe_${suffix}`)).toBe(true)
    expect(
      await isolated.application
        .select()
        .from(executions)
        .where(eq(executions.taskId, input.correlation.taskId))
    ).toHaveLength(1)
    expect(
      await isolated.application
        .select()
        .from(commandInbox)
        .where(eq(commandInbox.commandId, input.commandId))
    ).toHaveLength(1)
    await expect(
      recovered.acceptExecution({ ...input, payloadHash: 'c'.repeat(64) })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' })
  }, 15_000)

  test('atomically accepts one execution for concurrent duplicate commands and audits conflicts', async () => {
    const repository = new PostgresCommandAcceptanceRepository(isolated.application)
    const service = new CommandInboxService({
      repository,
      executionIdFactory: () => 'exe_01BRZ3NDEKTSV4RRFFQ69G5FAV',
      executionPlanValidator: { validate: async () => true },
      now: () => '2026-08-24T11:00:00.000Z',
    })
    const input = {
      callerPrincipalId: 'svc_agent-hq',
      operation: 'execution.accept',
      commandId: 'cmd_01BRZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01BRZ3NDEKTSV4RRFFQ69G5FAV',
      idempotencyKey: 'integration-task-1',
      payloadHash: 'c'.repeat(64),
      correlation: {
        workspaceId: 'wsp_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        projectId: 'prj_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: 'tsk_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        agentId: 'agt_01BRZ3NDEKTSV4RRFFQ69G5FAV',
      },
      executionPlan: {
        executionPlanId: 'pln_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        contentDigest: `sha256:${'d'.repeat(64)}`,
        schemaVersion: 1,
      },
      receivedAt: '2026-08-24T11:00:00.000Z',
      retentionExpiresAt: '2026-09-23T11:00:00.000Z',
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.acceptExecution(input))
    )

    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1)
    expect(new Set(results.map(({ execution }) => execution.executionId))).toEqual(
      new Set(['exe_01BRZ3NDEKTSV4RRFFQ69G5FAV'])
    )
    expect(
      await isolated.application
        .select()
        .from(executions)
        .where(eq(executions.taskId, input.correlation.taskId))
    ).toHaveLength(1)

    await expect(
      service.acceptExecution({ ...input, payloadHash: 'e'.repeat(64) })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' })
    const [record] = await isolated.application
      .select()
      .from(commandInbox)
      .where(eq(commandInbox.commandId, input.commandId))
    expect(record).toMatchObject({ conflictCount: 1, payloadHash: input.payloadHash })

    const processing = await service.transitionCommand({
      ...input,
      expectedVersion: record.version,
      to: 'processing',
      transitionedAt: '2026-08-24T11:01:00.000Z',
    })
    expect(processing).toMatchObject({ status: 'processing', version: record.version + 1 })
    expect(await repository.getByExecutionId(processing.executionId)).toEqual(processing)
    expect((await service.acceptExecution(input)).command).toEqual(processing)
    const atDeadline = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => {
        throw new Error('REPLAY_MUST_NOT_ALLOCATE')
      },
      executionPlanValidator: { validate: async () => false },
      now: () => input.retentionExpiresAt,
    })
    expect((await atDeadline.acceptExecution(input)).command).toEqual(processing)
    const expired = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => {
        throw new Error('EXPIRED_REPLAY_MUST_NOT_ALLOCATE')
      },
      executionPlanValidator: { validate: async () => false },
      now: () => new Date(Date.parse(input.retentionExpiresAt) + 1).toISOString(),
    })
    await expect(expired.acceptExecution(input)).rejects.toMatchObject({
      code: 'COMMAND_RETENTION_EXPIRED',
    })
    // Simulate an already-persisted pre-policy record, not new acceptance.
    const legacyDeadline = '2026-08-25T11:00:00.000Z'
    await isolated.application
      .update(commandInbox)
      .set({
        retentionExpiresAt: new Date(legacyDeadline),
      })
      .where(eq(commandInbox.commandId, input.commandId))
    const legacyService = new CommandInboxService({
      repository: new PostgresCommandAcceptanceRepository(isolated.application),
      executionIdFactory: () => {
        throw new Error('LEGACY_REPLAY_MUST_NOT_ALLOCATE')
      },
      executionPlanValidator: { validate: async () => false },
      now: () => legacyDeadline,
    })
    const legacy = await legacyService.acceptExecution({
      ...input,
      retentionExpiresAt: legacyDeadline,
    })
    expect(legacy.replayed).toBe(true)
    expect(legacy.command).toEqual({ ...processing, retentionExpiresAt: legacyDeadline })
  })

  test('persists one authorized interaction response across service restarts', async () => {
    const executionRepository = new PostgresExecutionRepository(isolated.application)
    const lifecycle = new ExecutionLifecycleService(executionRepository)
    const execution = await lifecycle.createExecution({
      executionId: 'exe_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      correlation: {
        workspaceId: 'wsp_01CRZ3NDEKTSV4RRFFQ69G5FAV',
        projectId: 'prj_01CRZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: 'tsk_01CRZ3NDEKTSV4RRFFQ69G5FAV',
        agentId: 'agt_01CRZ3NDEKTSV4RRFFQ69G5FAV',
        requestId: 'req_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      },
      executionPlan: {
        executionPlanId: 'pln_01CRZ3NDEKTSV4RRFFQ69G5FAV',
        contentDigest: `sha256:${'f'.repeat(64)}`,
        schemaVersion: 1,
      },
      acceptedAt: '2026-08-24T12:00:00.000Z',
    })
    const attempt = await lifecycle.createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      expectedExecutionVersion: execution.version,
      queuedAt: '2026-08-24T12:01:00.000Z',
    })
    const repository = new PostgresInteractionRepository(isolated.application)
    const service = new InteractionService(repository)
    const interaction = await service.request({
      interactionId: 'int_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      executionId: execution.executionId,
      attemptId: attempt.attemptId,
      kind: 'approval',
      prompt: { title: 'Approve the durable operation' },
      allowedActions: ['approve', 'deny'],
      allowedPrincipalIds: ['svc_agent-hq'],
      requestedAt: '2026-08-24T12:02:00.000Z',
      expiresAt: '2026-08-24T13:02:00.000Z',
    })
    const restarted = new InteractionService(
      new PostgresInteractionRepository(isolated.application)
    )
    const response = {
      interactionId: interaction.interactionId,
      executionId: execution.executionId,
      attemptId: attempt.attemptId,
      responseId: 'cmd_01CRZ3NDEKTSV4RRFFQ69G5FAV',
      action: 'approve',
      respondingPrincipalId: 'svc_agent-hq',
      expectedVersion: interaction.version,
      respondedAt: '2026-08-24T12:03:00.000Z',
    }

    expect(await restarted.respond(response)).toMatchObject({ state: 'responded', version: 2 })
    expect(await restarted.respond(response)).toMatchObject({ state: 'responded', version: 2 })
    expect(
      await isolated.application
        .select()
        .from(interactionRequests)
        .where(eq(interactionRequests.interactionId, interaction.interactionId))
    ).toHaveLength(1)
  })

  test('interaction command receipts retain one concurrent winner and first confirmed acknowledgement', async () => {
    await isolated.migrate()
    const repository = new PostgresInteractionCommandRepository(isolated.application)
    const request = structuredClone(ControlApiFixtures.interactionResponse.request)
    const alternative = { ...request, commandId: 'cmd_01JABCDEF0123456789ABCDEFH' }
    expect(await repository.get(request)).toBeUndefined()
    await expect(repository.markAccepted(request, '2026-09-08T00:00:00.000Z')).rejects.toThrow(
      'INTERACTION_COMMAND_MISSING'
    )
    await expect(
      repository.reserve({ request, acceptedAt: '2026-09-08T00:00:00.000Z' })
    ).rejects.toThrow('INTERACTION_COMMAND_PRECONFIRMED')
    const results = await Promise.all([
      repository.reserve({ request }),
      new PostgresInteractionCommandRepository(isolated.application).reserve({
        request: alternative,
      }),
    ])
    expect(results.filter((result) => result.inserted)).toHaveLength(1)
    expect(results[0].receipt).toEqual(results[1].receipt)
    const winner = results[0].receipt
    const restarted = new PostgresInteractionCommandRepository(isolated.application)
    expect(await restarted.get(request)).toEqual(winner)
    const accepted = await restarted.markAccepted(request, '2026-09-08T00:01:00.000Z')
    expect(accepted).toEqual({ ...winner, acceptedAt: '2026-09-08T00:01:00.000Z' })
    expect(await repository.markAccepted(request, '2026-09-08T00:02:00.000Z')).toEqual(accepted)
    expect(await repository.reserve({ request: alternative })).toEqual({
      receipt: accepted,
      inserted: false,
    })
    expect(
      await repository.get({ ...request, caller: { servicePrincipalId: 'svc_other' } })
    ).toBeUndefined()
    expect(
      await repository.get({ ...request, projectId: 'prj_01JABCDEF0123456789ABCDEFH' })
    ).toBeUndefined()
  })

  test('execution cancellation receipts retain one concurrent winner and first confirmed acknowledgement', async () => {
    await isolated.migrate()
    const repository = new PostgresExecutionCancellationRepository(isolated.application)
    const request = {
      ...ControlApiFixtures.executionAcceptance.request,
      operation: 'execution.cancel',
      payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
    }
    const alternative = { ...request, commandId: 'cmd_01JABCDEF0123456789ABCDEFH' }
    expect(await repository.get(request)).toBeUndefined()
    await expect(repository.markAccepted(request, '2026-09-08T00:00:00.000Z')).rejects.toThrow(
      'EXECUTION_CANCELLATION_MISSING'
    )
    await expect(
      repository.reserve({ request, acceptedAt: '2026-09-08T00:00:00.000Z' })
    ).rejects.toThrow('EXECUTION_CANCELLATION_PRECONFIRMED')
    const results = await Promise.all([
      repository.reserve({ request }),
      new PostgresExecutionCancellationRepository(isolated.application).reserve({
        request: alternative,
      }),
    ])
    expect(results.filter((result) => result.inserted)).toHaveLength(1)
    expect(results[0].receipt).toEqual(results[1].receipt)
    const winner = results[0].receipt
    const restarted = new PostgresExecutionCancellationRepository(isolated.application)
    expect(await restarted.get(request)).toEqual(winner)
    const accepted = await restarted.markAccepted(request, '2026-09-08T00:01:00.000Z')
    expect(accepted).toEqual({ ...winner, acceptedAt: '2026-09-08T00:01:00.000Z' })
    expect(await repository.markAccepted(request, '2026-09-08T00:02:00.000Z')).toEqual(accepted)
    expect(await repository.reserve({ request: alternative })).toEqual({
      receipt: accepted,
      inserted: false,
    })
    expect(
      await repository.get({ ...request, caller: { servicePrincipalId: 'svc_other' } })
    ).toBeUndefined()
    expect(
      await repository.get({ ...request, projectId: 'prj_01JABCDEF0123456789ABCDEFH' })
    ).toBeUndefined()
  })

  test('commits execution transitions and ordered outbox events atomically', async () => {
    const repository = new PostgresExecutionEventRepository(isolated.application)
    const service = new ExecutionEventService(repository)
    const executionId = 'exe_01BRZ3NDEKTSV4RRFFQ69G5FAV'
    const executionRepository = new PostgresExecutionRepository(isolated.application)
    const current = await executionRepository.getExecution(executionId)
    const queued = {
      ...current,
      state: 'queued',
      version: current.version + 1,
      queuedAt: '2026-08-24T11:02:00.000Z',
      updatedAt: '2026-08-24T11:02:00.000Z',
    }
    const draft = {
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      executionId,
      type: 'execution.queued',
      schemaVersion: 1,
      correlation: {
        workspaceId: current.correlation.workspaceId,
        projectId: current.correlation.projectId,
        taskId: current.correlation.taskId,
        agentId: current.correlation.agentId,
        requestId: current.correlation.requestId,
        traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      payload: { state: 'queued' },
      occurredAt: queued.updatedAt,
      recordedAt: queued.updatedAt,
      retentionExpiresAt: '2026-11-22T11:02:00.000Z',
    }
    expect(await repository.transitionExecution(current.version, queued, draft)).toMatchObject({
      sequence: 1,
    })

    const stored = await executionRepository.getExecution(executionId)
    const running = {
      ...stored,
      state: 'running',
      version: stored.version + 1,
      runningAt: '2026-08-24T11:03:00.000Z',
      updatedAt: '2026-08-24T11:03:00.000Z',
    }
    expect(await repository.transitionExecution(stored.version, running, draft)).toBeUndefined()
    expect((await executionRepository.getExecution(executionId)).version).toBe(stored.version)

    const events = await Promise.all([
      service.append({
        ...draft,
        eventId: 'evt_01BRZ3NDEKTSV4RRFFQ69G5FAV',
        type: 'execution.progressed',
      }),
      service.append({
        ...draft,
        eventId: 'evt_01CRZ3NDEKTSV4RRFFQ69G5FAV',
        type: 'execution.progressed',
      }),
    ])
    expect(events.map(({ sequence }) => sequence).sort()).toEqual([2, 3])
    expect(
      (await repository.queryAfter(executionId, 1, 10)).map(({ sequence }) => sequence)
    ).toEqual([2, 3])

    const delivered = []
    const dispatcher = new ExecutionEventDispatcher({
      repository,
      publicationService: service,
      transport: {
        deliver: async (envelope) => {
          delivered.push(envelope)
          return { outcome: 'accepted' }
        },
      },
      now: () => '2026-08-24T11:04:00.000Z',
    })
    expect(await dispatcher.dispatchBatch(10)).toEqual({
      delivered: 3,
      failed: 0,
      quarantined: 0,
    })
    expect(delivered.map(({ eventId }) => eventId)).toHaveLength(3)
    expect(await repository.queryPending(10)).toEqual([])
    const [template] = await isolated.application
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.executionId, executionId))
      .limit(1)
    const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
    await isolated.application.insert(executionEvents).values(
      Array.from({ length: 1002 }, (_, index) => ({
        ...template,
        eventId: `evt_${String(index).padStart(26, '0')}`,
        sequence: index + 4,
        attemptId,
        eventType: index === 1000 ? 'interaction.requested' : 'execution.progressed',
      }))
    )
    expect(
      (await repository.queryAfter(executionId, 0, 1000)).some(
        (event) => event.type === 'interaction.requested'
      )
    ).toBe(false)
    expect(await repository.latestInteraction(executionId, attemptId)).toMatchObject({
      sequence: 1004,
      type: 'interaction.requested',
      attemptId,
    })
    expect(
      await repository.latestInteraction(executionId, 'att_01JABCDEF0123456789ABCDEFH')
    ).toBeUndefined()
    await isolated.application
      .update(executionEvents)
      .set({ archivedAt: new Date() })
      .where(eq(executionEvents.eventId, `evt_${String(1000).padStart(26, '0')}`))
    expect(await repository.latestInteraction(executionId, attemptId)).toBeUndefined()
  })

  test('commits inbox and outbox writes atomically and rolls them back together', async () => {
    await isolated.transaction(async (transaction) => {
      await transaction.insert(inboxMessages).values({
        consumer: 'integration-test',
        messageId: 'message-1',
        payload: { kind: 'command' },
      })
      await transaction.insert(outboxEvents).values({
        aggregateId: 'aggregate-1',
        aggregateType: 'test',
        eventType: 'test.completed',
        payload: { kind: 'event' },
      })
    })

    await expect(
      isolated.transaction(async (transaction) => {
        await transaction.insert(inboxMessages).values({
          consumer: 'integration-test',
          messageId: 'message-rollback',
          payload: {},
        })
        await transaction.insert(outboxEvents).values({
          aggregateId: 'aggregate-rollback',
          aggregateType: 'test',
          eventType: 'test.rolled_back',
          payload: {},
        })
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')

    expect(
      await isolated.application
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.consumer, 'integration-test'))
    ).toHaveLength(1)
    expect(
      await isolated.application
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateType, 'test'))
    ).toHaveLength(1)
  })

  test('scopes usage ledger reads and idempotency to workspace', async () => {
    const first = {
      workspaceId: 'wsp_01KABCDEF0123456789ABCDEFG',
      executionId: 'exe_01KABCDEF0123456789ABCDEFG',
    }
    const second = {
      workspaceId: 'wsp_01KBCDEF0123456789ABCDEFGH',
      executionId: 'exe_01KBCDEF0123456789ABCDEFGH',
    }
    const now = new Date('2026-08-25T12:00:00.000Z')
    await isolated.application.insert(executions).values(
      [first, second].map((scope, index) => ({
        ...scope,
        state: 'accepted',
        version: 1,
        projectId: `prj_01K${index}CDEF0123456789ABCDEFGH`,
        taskId: `tsk_01K${index}CDEF0123456789ABCDEFGH`,
        agentId: `agt_01K${index}CDEF0123456789ABCDEFGH`,
        requestId: `req_01K${index}CDEF0123456789ABCDEFGH`,
        executionPlanId: `pln_01K${index}CDEF0123456789ABCDEFGH`,
        executionPlanDigest: `sha256:${String(index + 1).repeat(64)}`,
        executionPlanSchemaVersion: 1,
        attemptCount: 0,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      }))
    )
    const repository = new PostgresUsageLedgerRepository(isolated.application)
    const entry = (scope, suffix) => ({
      entryId: `usg_01K${suffix}CDEF0123456789ABCDEFGH`,
      sequence: 1,
      ...scope,
      kind: 'model_usage',
      source: { sourceId: 'provider-request', idempotencyKey: 'shared-idempotency-key' },
      fundingSource: 'hq_managed',
      quantity: { unit: 'tokens', value: 1 },
      currency: 'USD',
      costMicrounits: 1,
      costExact: true,
      recordedAt: now.toISOString(),
    })

    await expect(repository.append(entry(first, 'A'))).resolves.toMatchObject({
      outcome: 'created',
    })
    await expect(repository.append(entry(second, 'B'))).resolves.toMatchObject({
      outcome: 'created',
    })
    await expect(
      repository.append(
        entry({ workspaceId: second.workspaceId, executionId: first.executionId }, 'C')
      )
    ).rejects.toThrow('USAGE_LEDGER_SCOPE_MISMATCH')
    expect(await repository.list(first.workspaceId, first.executionId)).toHaveLength(1)
    expect(await repository.list(second.workspaceId, first.executionId)).toEqual([])
  })

  test('persists memory proposals with workspace dedupe and optimistic transitions', async () => {
    await isolated.migrate()
    const repository = new PostgresMemoryWriteProposalRepository(isolated.application)
    const proposed = {
      proposalId: 'mwp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      memoryType: 'fact',
      content: 'Durable proposal fixture',
      retention: 'project',
      provenance: {
        sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        sourceAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        confidence: 0.9,
        importance: 0.8,
        sensitivity: 'internal',
        evidenceRefs: [],
        artifactRefs: [],
      },
      dedupeHint: 'integration:memory-proposal',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      state: 'proposed',
      version: 1,
      createdAt: '2026-08-25T12:00:00.000Z',
      updatedAt: '2026-08-25T12:00:00.000Z',
    }
    expect(await repository.insert(proposed)).toBe(true)
    expect(await repository.insert(proposed)).toBe(false)
    expect(await repository.getByDedupe(proposed.workspaceId, proposed.dedupeHint)).toEqual(
      proposed
    )
    const approved = {
      ...proposed,
      state: 'approved',
      version: 2,
      updatedAt: '2026-08-25T12:01:00.000Z',
      outcome: { code: 'approved', observedAt: '2026-08-25T12:01:00.000Z' },
    }
    expect(await repository.compareAndSet(1, approved)).toBe(true)
    expect(await repository.compareAndSet(1, approved)).toBe(false)
    expect(await repository.list()).toEqual([approved])
  })
})

function runtimeDiscoveryProjection() {
  const observedAt = '2026-08-30T12:00:00.000Z'
  return {
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    family: 'mock',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      location: 'local_device',
      status: 'online',
      health: 'online',
      observedAt,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0' },
    capabilities: ['tool.call'],
    capabilityDetails: [{ name: 'tool.call', support: 'supported' }],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt,
    limitations: [],
  }
}

function externalSessionDiscoveryProjection() {
  const observedAt = '2026-08-30T12:00:00.000Z'
  return {
    externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    state: 'active',
    recoverable: true,
    display: { origin: 'created_through_control_plane' },
    freshness: { state: 'fresh', observedAt },
    capabilitySummary: {
      version: 1,
      operations: ['session.resume'],
      controls: {
        reference: { available: true },
        resume: { available: true },
        load: { available: true },
        close: { available: true },
        history: { available: false, reason: 'HISTORY_UNAVAILABLE' },
      },
    },
    limitations: [],
  }
}

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  PostgresCommandAcceptanceRepository,
  PostgresExecutionCancellationRepository,
  PostgresExecutionEventRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresReconciliationCheckpointRepository,
} from '@control-plane/database'
import { ReconciliationScheduler, RetentionSweep } from '@control-plane/deployment'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { HostedServerControlPlaneComposition } from './index.ts'
import { HostedServerGraphRuntime } from './hosted-graph-runtime.ts'

function fakeConnection() {
  return {
    database: {},
    check: async () => undefined,
    close: async () => undefined,
  }
}

const identityPublicKey = 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f'
const dataDirectory = '/unused-hosted-reconciliation-test'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const commandId = 'cmd_01JABCDEF0123456789ABCDEFG'
const planPin = {
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  contentDigest: `sha256:${'e'.repeat(64)}`,
  schemaVersion: 1,
}

async function withPrototypeOverrides(overrides, action) {
  const previous = overrides.map(({ prototype, method }) => ({
    prototype,
    method,
    value: prototype[method],
  }))
  for (const { prototype, method, value } of overrides) prototype[method] = value
  try {
    return await action()
  } finally {
    for (const { prototype, method, value } of previous.toReversed()) prototype[method] = value
  }
}

function retainedWakeConfiguration(assertCurrent = async () => undefined) {
  return {
    placement: {
      controlPlaneHostId: 'host:test',
      runtimeHostId: 'host:test',
      runtimeLocation: 'remote_host',
      coLocated: true,
    },
    guards: {
      authority: { assertCurrent },
      residency: { assertCurrent: async () => undefined },
    },
  }
}

function wakeExecution() {
  return {
    executionId,
    state: 'accepted',
    attemptCount: 0,
    correlation: {
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    },
    executionPlan: planPin,
    deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function wakeCommand() {
  return {
    commandId,
    executionId,
    status: 'accepted',
    retentionExpiresAt: new Date(Date.now() + 48 * 24 * 60 * 60_000).toISOString(),
  }
}

async function expectRetainedWakeUnbound(composition) {
  await withPrototypeOverrides(
    [
      {
        prototype: PostgresExecutionRepository.prototype,
        method: 'getExecution',
        value: async () => wakeExecution(),
      },
      {
        prototype: PostgresCommandAcceptanceRepository.prototype,
        method: 'getByExecutionId',
        value: async () => wakeCommand(),
      },
      {
        prototype: PostgresExecutionCancellationRepository.prototype,
        method: 'listByExecution',
        value: async () => [],
      },
    ],
    async () => {
      await expect(
        composition.reconciliationEffects.resumeWorkflow({ executionId, checkpointId: 'rcp_test' })
      ).rejects.toThrow('HOSTED_PROFILE_WORKFLOW_WAKE_NOT_BOUND')
    }
  )
}

describe('hosted composition reconciliation wiring', () => {
  function reconciliationOptions() {
    return {
      source: {
        load: async () => {
          throw new Error('unused')
        },
        listCandidates: async () => [],
      },
      effects: {
        markReconciliationRequired: async () => undefined,
        resumeWorkflow: async () => undefined,
        applyRuntimeTerminal: async () => undefined,
        replayEvents: async () => undefined,
      },
      intervalMs: 1_000,
      batchLimit: 10,
    }
  }

  test('schedules reconciliation only from explicit configuration', () => {
    const unconfigured = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
    })
    expect(unconfigured.reconciliationService).toBeUndefined()

    const configured = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      reconciliation: reconciliationOptions(),
    })
    expect(configured.reconciliationService).toBeDefined()
  })

  test('binds the retained Hosted wake only when trusted authority and placement guards are supplied', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-profile-wake-'))
    const guardCalls = []
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      workflowRuntime: {
        profile: 'hosted-server',
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      profileWorkflowWake: {
        placement: {
          controlPlaneHostId: 'host:test',
          runtimeHostId: 'host:test',
          runtimeLocation: 'remote_host',
          coLocated: true,
        },
        guards: {
          authority: {
            assertCurrent: async (context) => guardCalls.push(['authority', context]),
          },
          residency: {
            assertCurrent: async (context) => guardCalls.push(['residency', context]),
          },
        },
      },
    })
    try {
      await composition.start()
      expect(guardCalls.map(([kind]) => kind)).toEqual(['residency'])
      expect(guardCalls[0][1]).toMatchObject({
        profile: 'self-hosted',
        deploymentProfile: 'hosted-server',
        operation: 'compose',
        placement: {
          controlPlaneHostId: 'host:test',
          runtimeHostId: 'host:test',
          runtimeLocation: 'remote_host',
          coLocated: true,
        },
      })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('clears the retained wake after graph startup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-profile-graph-failure-'))
    const originalStart = HostedServerGraphRuntime.prototype.start
    const originalClose = HostedServerGraphRuntime.prototype.close
    const graphCloseCalls = []
    HostedServerGraphRuntime.prototype.start = async function () {
      throw new Error('graph startup failed')
    }
    HostedServerGraphRuntime.prototype.close = async function () {
      graphCloseCalls.push(this)
    }
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      hostedGraphEnabled: true,
      hostedGraphToolConfiguration: {
        schemaVersion: 1,
        toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
        toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
        currency: 'USD',
        costMicrounits: 1,
        createdAt: '2026-08-23T12:00:00.000Z',
        publishedAt: '2026-08-23T12:00:00.000Z',
      },
      workflowRuntime: {
        profile: 'hosted-server',
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      reconciliation: { projection: 'observation', intervalMs: 1_000, batchLimit: 10 },
      profileWorkflowWake: retainedWakeConfiguration(),
    })
    try {
      await expect(composition.start()).rejects.toThrow('graph startup failed')
      expect(graphCloseCalls).toHaveLength(1)
      await expectRetainedWakeUnbound(composition)
    } finally {
      HostedServerGraphRuntime.prototype.start = originalStart
      HostedServerGraphRuntime.prototype.close = originalClose
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('clears the retained wake after endpoint startup failure and preserves the startup error', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'control-plane-hosted-profile-endpoint-failure-')
    )
    const calls = []
    const originalRetentionClose = RetentionSweep.prototype.close
    RetentionSweep.prototype.close = function () {
      calls.push('retention.close')
      throw new Error('retention cleanup failed')
    }
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      workflowRuntime: {
        profile: 'hosted-server',
        start: async () => undefined,
        stop: async () => calls.push('workflow.stop'),
        health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
      },
      endpointFactory: {
        create: async () => ({
          run: async () => {
            throw new Error('endpoint startup failed')
          },
          shutdown: async () => calls.push('endpoint.shutdown'),
        }),
      },
      reconciliation: { projection: 'observation', intervalMs: 1_000, batchLimit: 10 },
      profileWorkflowWake: retainedWakeConfiguration(),
    })
    try {
      await expect(composition.start()).rejects.toThrow('endpoint startup failed')
      expect(calls).toEqual(['retention.close', 'workflow.stop', 'endpoint.shutdown'])
      await expectRetainedWakeUnbound(composition)
    } finally {
      RetentionSweep.prototype.close = originalRetentionClose
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('clears the retained wake after a failed scheduler drain and attempts every release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-profile-close-failure-'))
    const calls = []
    const originalSchedulerClose = ReconciliationScheduler.prototype.close
    let scheduler
    ReconciliationScheduler.prototype.close = async function () {
      scheduler = this
      calls.push('scheduler.close')
      throw new Error('scheduler close failed')
    }
    const connection = { ...fakeConnection(), close: async () => calls.push('connection.close') }
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection,
      workflowRuntime: {
        profile: 'hosted-server',
        start: async () => undefined,
        stop: async () => calls.push('workflow.stop'),
        health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
      },
      endpointFactory: {
        create: async () => ({
          run: async () => undefined,
          shutdown: async () => calls.push('endpoint.shutdown'),
        }),
      },
      reconciliation: { projection: 'observation', intervalMs: 1_000, batchLimit: 10 },
      profileWorkflowWake: retainedWakeConfiguration(),
    })
    try {
      await composition.start()
      await expect(composition.close()).rejects.toThrow('scheduler close failed')
      expect(calls).toEqual([
        'scheduler.close',
        'workflow.stop',
        'endpoint.shutdown',
        'connection.close',
      ])
      await expectRetainedWakeUnbound(composition)
    } finally {
      ReconciliationScheduler.prototype.close = originalSchedulerClose
      await originalSchedulerClose.call(scheduler)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('drains an accepted unstarted reconciliation before clearing its retained wake on close', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'control-plane-hosted-profile-wake-submissions-')
    )
    const plan = createExecutionPlanTestFixture()
    const reference = {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    }
    const commandsByKey = new Map()
    const commandsByExecution = new Map()
    const executions = new Map()
    const checkpoints = new Map()
    const submissions = []
    const closeEvents = []
    let authorityCurrent = true
    let scheduledExecutionId
    let pauseAtReconciliationRequired = false
    let signalReconciliationBoundary
    const reconciliationBoundaryReached = new Promise((resolve) => {
      signalReconciliationBoundary = resolve
    })
    let releaseReconciliationBoundary
    const reconciliationBoundaryReleased = new Promise((resolve) => {
      releaseReconciliationBoundary = resolve
    })
    let compositionClosed = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      const submitted = JSON.parse(init.body)
      submissions.push(submitted)
      if (submitted.executionId === scheduledExecutionId) closeEvents.push('recovery.submit')
      return {
        status: 202,
        text: async () => '{"status":"Accepted","invocationId":"inv_0123456789"}',
      }
    }

    const saveCommand = (command) => {
      commandsByKey.set(command.idempotencyKey, command)
      commandsByExecution.set(command.executionId, command)
    }
    const overrides = [
      {
        prototype: PostgresCommandAcceptanceRepository.prototype,
        method: 'get',
        value: async (scope) => commandsByKey.get(scope.idempotencyKey),
      },
      {
        prototype: PostgresCommandAcceptanceRepository.prototype,
        method: 'accept',
        value: async (command, execution) => {
          saveCommand(command)
          executions.set(execution.executionId, execution)
          return { outcome: 'accepted', command, execution }
        },
      },
      {
        prototype: PostgresCommandAcceptanceRepository.prototype,
        method: 'compareAndSet',
        value: async (expectedVersion, command) => {
          const current = commandsByKey.get(command.idempotencyKey)
          if (!current || current.version !== expectedVersion) return false
          saveCommand(command)
          return true
        },
      },
      {
        prototype: PostgresCommandAcceptanceRepository.prototype,
        method: 'getByExecutionId',
        value: async (id) => commandsByExecution.get(id),
      },
      {
        prototype: PostgresExecutionRepository.prototype,
        method: 'getExecution',
        value: async (id) => {
          const current = executions.get(id)
          if (
            id === scheduledExecutionId &&
            pauseAtReconciliationRequired &&
            current?.state === 'reconciliation_required'
          ) {
            pauseAtReconciliationRequired = false
            signalReconciliationBoundary()
            await reconciliationBoundaryReleased
          }
          return executions.get(id)
        },
      },
      {
        prototype: PostgresExecutionRepository.prototype,
        method: 'listReconciliationCandidates',
        value: async () => (scheduledExecutionId === undefined ? [] : [scheduledExecutionId]),
      },
      {
        prototype: PostgresExecutionRepository.prototype,
        method: 'compareAndSetExecution',
        value: async (expectedVersion, execution) => {
          const current = executions.get(execution.executionId)
          if (!current || current.version !== expectedVersion) return false
          executions.set(execution.executionId, execution)
          return true
        },
      },
      {
        prototype: PostgresExecutionPlanRepository.prototype,
        method: 'get',
        value: async (requested) =>
          requested.executionPlanId === reference.executionPlanId &&
          requested.contentDigest === reference.contentDigest
            ? plan
            : undefined,
      },
      {
        prototype: ExecutionPlanAcceptanceValidator.prototype,
        method: 'validate',
        value: async () => true,
      },
      {
        prototype: PostgresExecutionEventRepository.prototype,
        method: 'summarizePendingDelivery',
        value: async () => ({ pendingCount: 0 }),
      },
      {
        prototype: PostgresExecutionCancellationRepository.prototype,
        method: 'listByExecution',
        value: async () => [],
      },
      {
        prototype: PostgresReconciliationCheckpointRepository.prototype,
        method: 'getByObservationHash',
        value: async (hash) => checkpoints.get(hash),
      },
      {
        prototype: PostgresReconciliationCheckpointRepository.prototype,
        method: 'insert',
        value: async (checkpoint) => {
          if (checkpoints.has(checkpoint.observationHash)) return false
          checkpoints.set(checkpoint.observationHash, checkpoint)
          return true
        },
      },
      {
        prototype: PostgresReconciliationCheckpointRepository.prototype,
        method: 'compareAndSet',
        value: async (expectedVersion, checkpoint) => {
          const current = checkpoints.get(checkpoint.observationHash)
          if (!current || current.version !== expectedVersion) return false
          checkpoints.set(checkpoint.observationHash, checkpoint)
          return true
        },
      },
    ]

    try {
      await withPrototypeOverrides(overrides, async () => {
        const composition = new HostedServerControlPlaneComposition({
          dataDirectory: directory,
          databaseUrl: 'postgresql://app:secret@postgres/control_plane',
          requestIdentityPublicKey: identityPublicKey,
          connection: fakeConnection(),
          workflowRuntime: {
            profile: 'hosted-server',
            start: async () => undefined,
            stop: async () => closeEvents.push('workflow.stop'),
            health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
          },
          endpointFactory: {
            create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
          },
          reconciliation: { projection: 'observation', intervalMs: 10, batchLimit: 10 },
          profileWorkflowWake: retainedWakeConfiguration(async () => {
            if (!authorityCurrent) throw new Error('current product authority revoked')
          }),
        })
        try {
          await composition.start()
          const requestFor = (variant) => {
            const issuedAt = new Date().toISOString()
            const baseId = 'cmd_01JABCDEF0123456789ABCDEF'
            const suffix = ['G', 'H', 'J'][variant]
            return {
              ...ControlApiFixtures.executionAcceptance.request,
              commandId: `${baseId}${suffix}`,
              idempotencyKey: `hosted-profile-wake-${variant}`,
              requestId: plan.correlation.requestId,
              issuedAt,
              workspaceId: plan.correlation.workspaceId,
              projectId: plan.correlation.projectId,
              payload: {
                ...ControlApiFixtures.executionAcceptance.request.payload,
                taskId: plan.correlation.taskId,
                agentId: plan.correlation.agentId,
                executionPlan: reference,
                deadlineAt: new Date(Date.parse(issuedAt) + 30 * 60_000).toISOString(),
                retentionExpiresAt: new Date(
                  Date.parse(issuedAt) + 48 * 24 * 60 * 60_000
                ).toISOString(),
              },
            }
          }

          const accepted = await composition.executionAcceptanceService.accept(
            requestFor(0),
            'svc_agent-hq'
          )
          expect(accepted.data.status).toBe('processing')
          expect(submissions).toHaveLength(1)

          const acceptedExecutionId = accepted.data.executionId
          const acceptedExecution = executions.get(acceptedExecutionId)
          const acceptedCommand = commandsByExecution.get(acceptedExecutionId)
          executions.set(acceptedExecutionId, { ...acceptedExecution, state: 'accepted' })
          saveCommand({ ...acceptedCommand, status: 'accepted' })
          const checkpoint = await composition.reconciliationService.reconcile(acceptedExecutionId)
          expect(checkpoint).toMatchObject({ reason: 'accepted_unstarted', state: 'remediated' })
          expect(submissions).toHaveLength(2)
          expect(commandsByExecution.get(acceptedExecutionId).status).toBe('processing')

          authorityCurrent = false
          await expect(
            composition.executionAcceptanceService.accept(requestFor(1), 'svc_agent-hq')
          ).rejects.toMatchObject({ response: { code: 'RESTATE_SUBMISSION_UNCONFIRMED' } })
          const deniedExecutionId = [...commandsByExecution.keys()].find((id) =>
            commandsByExecution.get(id).idempotencyKey.endsWith('-1')
          )
          expect(deniedExecutionId).toBeDefined()
          await expect(
            composition.reconciliationService.reconcile(deniedExecutionId)
          ).rejects.toThrow('current product authority revoked')
          expect(submissions).toHaveLength(2)

          authorityCurrent = true
          const closingAcceptance = await composition.executionAcceptanceService.accept(
            requestFor(2),
            'svc_agent-hq'
          )
          expect(closingAcceptance.data.status).toBe('processing')
          const closingExecutionId = closingAcceptance.data.executionId
          const closingExecution = executions.get(closingExecutionId)
          const closingCommand = commandsByExecution.get(closingExecutionId)
          executions.set(closingExecutionId, { ...closingExecution, state: 'accepted' })
          saveCommand({ ...closingCommand, status: 'accepted' })
          scheduledExecutionId = closingExecutionId
          pauseAtReconciliationRequired = true

          await reconciliationBoundaryReached
          expect(executions.get(closingExecutionId).state).toBe('reconciliation_required')
          expect(commandsByExecution.get(closingExecutionId).status).toBe('reconciliation_required')

          let closeResolved = false
          const closePromise = composition.close().then(() => {
            closeResolved = true
            compositionClosed = true
          })
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(closeResolved).toBe(false)
          releaseReconciliationBoundary()
          await closePromise

          expect(submissions).toHaveLength(4)
          expect(commandsByExecution.get(closingExecutionId).status).toBe('processing')
          expect(closeEvents).toEqual(['recovery.submit', 'workflow.stop'])
          const acceptedUnstartedCheckpoint = [...checkpoints.values()].find(
            (checkpointEntry) =>
              checkpointEntry.executionId === closingExecutionId &&
              checkpointEntry.reason === 'accepted_unstarted'
          )
          expect(acceptedUnstartedCheckpoint).toMatchObject({ state: 'remediated' })
          const laterDecision =
            await composition.reconciliationService.reconcile(closingExecutionId)
          expect(laterDecision).toMatchObject({ reason: 'healthy', action: 'none' })
          expect(submissions).toHaveLength(4)
        } finally {
          releaseReconciliationBoundary()
          if (!compositionClosed) await composition.close()
        }
      })
    } finally {
      globalThis.fetch = originalFetch
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('starts retention independently of reconciliation configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-retention-'))
    const starts = []
    const closes = []
    const originalStart = RetentionSweep.prototype.start
    const originalClose = RetentionSweep.prototype.close
    RetentionSweep.prototype.start = function () {
      starts.push(this)
      return originalStart.call(this)
    }
    RetentionSweep.prototype.close = function () {
      closes.push(this)
      return originalClose.call(this)
    }
    try {
      for (const reconciliation of [undefined, reconciliationOptions()]) {
        const composition = new HostedServerControlPlaneComposition({
          dataDirectory: directory,
          databaseUrl: 'postgresql://app:secret@postgres/control_plane',
          requestIdentityPublicKey: identityPublicKey,
          connection: fakeConnection(),
          workflowRuntime: {
            start: async () => undefined,
            stop: async () => undefined,
            health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
          },
          endpointFactory: {
            create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
          },
          ...(reconciliation === undefined ? {} : { reconciliation }),
        })
        await composition.start()
        await composition.close()
      }
      expect(starts).toHaveLength(2)
      expect(closes).toHaveLength(2)
    } finally {
      RetentionSweep.prototype.start = originalStart
      RetentionSweep.prototype.close = originalClose
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('validates retention cadence without reconciliation configuration', () => {
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          dataDirectory,
          databaseUrl: 'postgresql://app:secret@postgres/control_plane',
          requestIdentityPublicKey: identityPublicKey,
          connection: fakeConnection(),
          retentionSweepIntervalMs: 0,
        })
    ).toThrow('RETENTION_SWEEP_INVALID_INTERVAL')
  })

  test('fails closed on invalid reconciliation schedule bounds', () => {
    const base = {
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
    }
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          ...base,
          reconciliation: { ...reconciliationOptions(), intervalMs: 3_600_001 },
        })
    ).toThrow('Invalid reconciliation scheduler intervalMs')
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          ...base,
          reconciliation: { ...reconciliationOptions(), batchLimit: 0 },
        })
    ).toThrow('Invalid reconciliation scheduler batchLimit')
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          ...base,
          reconciliation: {
            ...reconciliationOptions(),
            rateLimit: { windowMs: 1_000, maximumPerWindow: 10_001 },
          },
        })
    ).toThrow('INVALID_RECONCILIATION_RATE_LIMIT')
  })

  test('injects the metric adapter into the composed command inbox', () => {
    const added = []
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      metricAdapter: {
        add: (name, value, attributes) => added.push({ name, value, attributes }),
        record: () => undefined,
      },
      reconciliation: reconciliationOptions(),
    })
    expect(composition.executionAcceptanceService).toBeDefined()
    expect(composition.reconciliationService).toBeDefined()
    expect(added).toEqual([])
  })
})

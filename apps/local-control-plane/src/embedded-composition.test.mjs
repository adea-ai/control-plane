import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  EmbeddedExecutionWorkflowDispatcher,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import { LocalControlPlaneComposition } from './composition.ts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
} from '@control-plane/sqlite-persistence'

const restateWorkflowFake = (calls) => ({
  profile: 'hosted-simple',
  start: async () => calls.push('workflow:start'),
  health: async () => ({ ready: true, component: 'restate', version: '1.7.10' }),
  stop: async () => calls.push('workflow:stop'),
})

const restateEndpointFake = (calls) => ({
  create: async () => ({
    run: async () => calls.push('endpoint:start'),
    shutdown: async () => calls.push('endpoint:stop'),
  }),
})

describe('Local control plane embedded durable execution', () => {
  test('new queue jobs require retained parents while existing job replay stays exempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-embedded-refs-'))
    const composition = new LocalControlPlaneComposition({ dataDirectory: directory })
    try {
      await composition.persistence.migrate()
      const package_ = contextPackageSerializationFixtures.futurePi
      const plan = createExecutionPlanTestFixture({ contextPackage: package_ })
      const packages = new SqliteContextPackageRepository(composition.persistence)
      await packages.put(package_)
      const reference = {
        ...(await new SqliteExecutionPlanRepository(composition.persistence).put(plan)),
        schemaVersion: plan.schemaVersion,
      }
      const input = {
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
        executionPlan: reference,
        marketplacePluginReferences: [
          {
            pluginId: 'plugin:control-plane:guard-fixture',
            releaseId: `release:${'a'.repeat(64)}`,
            canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
          },
        ],
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }
      await expect(composition.workflowDispatcher.submit(input)).rejects.toThrow(
        'WORKFLOW_EXECUTION_REFERENCE_INVALID'
      )
      expect(await composition.workflowJobs.get(input.executionId)).toBeUndefined()
      await new ExecutionLifecycleService(
        new SqliteExecutionRepository(composition.persistence)
      ).createExecution({
        executionId: input.executionId,
        correlation: plan.correlation,
        executionPlan: reference,
        marketplacePluginReferences: input.marketplacePluginReferences,
        acceptedAt: new Date().toISOString(),
      })
      const storedId = (id) => `r-${createHash('sha256').update(id).digest('hex')}`
      await expect(
        composition.workflowDispatcher.submit({
          ...input,
          executionPlan: { ...reference, schemaVersion: 2 },
        })
      ).rejects.toThrow('WORKFLOW_EXECUTION_REFERENCE_INVALID')
      await expect(
        composition.workflowDispatcher.submit({ ...input, marketplacePluginReferences: undefined })
      ).rejects.toThrow('WORKFLOW_EXECUTION_REFERENCE_INVALID')
      await expect(
        composition.workflowDispatcher.submit({
          ...input,
          marketplacePluginReferences: [
            { ...input.marketplacePluginReferences[0], releaseId: `release:${'c'.repeat(64)}` },
          ],
        })
      ).rejects.toThrow('WORKFLOW_EXECUTION_REFERENCE_INVALID')
      expect(await composition.workflowJobs.get(input.executionId)).toBeUndefined()
      await composition.persistence.transaction((transaction) =>
        transaction.delete('context-packages', storedId(package_.contextPackageId))
      )
      await expect(composition.workflowDispatcher.submit(input)).rejects.toThrow()
      expect(await composition.workflowJobs.get(input.executionId)).toBeUndefined()
      await packages.put(package_)
      await composition.workflowDispatcher.submit(input)
      const original = await composition.workflowJobs.get(input.executionId)
      expect(original.status).toBe('queued')
      // Simulate a historical stored job with missing parents, not a supported
      // operational deletion path: duplicate delivery must preserve its receipt.
      await composition.persistence.transaction(async (transaction) => {
        await transaction.delete('executions', storedId(input.executionId))
        await transaction.delete('execution-plans', storedId(reference.executionPlanId))
        await transaction.delete('context-packages', storedId(package_.contextPackageId))
      })
      await composition.workflowDispatcher.submit(input)
      expect(await composition.workflowJobs.get(input.executionId)).toEqual(original)
    } finally {
      await composition.close()
      composition.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  test('composes the local profile on the embedded queue with no Restate process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-embedded-'))
    const composition = new LocalControlPlaneComposition({ dataDirectory: directory })
    try {
      expect(composition.workflowJobs).toBeInstanceOf(WorkflowJobStore)
      expect(composition.workflowDispatcher).toBeInstanceOf(EmbeddedExecutionWorkflowDispatcher)
      await composition.start()
      const manifest = await composition.manifest()
      expect(manifest.topology.durableExecution).toBe('embedded-sqlite')
      expect(manifest.topology.restateVersion).toBeUndefined()
      expect(manifest.topology.externalServices).toBe(0)
      expect(manifest.components.every(({ ready }) => ready)).toBe(true)
      const workflow = await composition.workflow.health()
      expect(workflow.component).toBe('embedded-workflow-runtime')
      expect(workflow.ready).toBe(true)
      await expect(composition.discovery.resolve('restate')).rejects.toThrow(
        'SERVICE_ENDPOINT_NOT_FOUND'
      )
      // The embedded runtime owns the durable queue directly; nothing listens
      // on the Restate ingress or workflow endpoint ports.
      expect(composition.runtimeTransport).toBeUndefined()
    } finally {
      await composition.close()
      composition.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps the bundled Restate path for hosted-simple', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-simple-'))
    const calls = []
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      profile: 'hosted-simple',
      workflowRuntime: restateWorkflowFake(calls),
      endpointFactory: restateEndpointFake(calls),
    })
    try {
      await composition.start()
      const manifest = await composition.manifest()
      expect(manifest.topology.durableExecution).toBe('restate')
      expect(manifest.topology.restateVersion).toBe('1.7.10')
      expect((await composition.discovery.resolve('restate')).private).toBe(true)
      expect(calls).toEqual(['endpoint:start', 'workflow:start'])
    } finally {
      await composition.close()
      composition.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
    expect(calls).toEqual(['endpoint:start', 'workflow:start', 'workflow:stop', 'endpoint:stop'])
  })

  test('routes local execution submissions into the durable queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-embedded-accept-'))
    const transportCalls = []
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      runtimeTransport: {
        transportKind: 'direct-local',
        open: async () => transportCalls.push('open'),
        close: async () => transportCalls.push('close'),
      },
    })
    try {
      await composition.persistence.migrate()
      const package_ = contextPackageSerializationFixtures.futurePi
      const plan = createExecutionPlanTestFixture({ contextPackage: package_ })
      await new SqliteContextPackageRepository(composition.persistence).put(package_)
      const reference = {
        ...(await new SqliteExecutionPlanRepository(composition.persistence).put(plan)),
        schemaVersion: plan.schemaVersion,
      }
      await new ExecutionLifecycleService(
        new SqliteExecutionRepository(composition.persistence)
      ).createExecution({
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        correlation: plan.correlation,
        executionPlan: reference,
        acceptedAt: new Date().toISOString(),
      })
      await composition.start()
      // Acceptance is wired to the queue-backed dispatcher: enqueuing through
      // the same port the Restate ingress client implements lands a job.
      await composition.workflowDispatcher.submit({
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
        executionPlan: reference,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const job = await composition.workflowJobs.get('exe_01JABCDEF0123456789ABCDEFG')
      expect(job?.status).toBe('queued')
      expect(transportCalls).toEqual(['open'])
    } finally {
      await composition.close()
      composition.persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

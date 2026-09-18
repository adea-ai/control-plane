import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  EmbeddedExecutionWorkflowDispatcher,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import { LocalControlPlaneComposition } from './composition.ts'

const restateWorkflowFake = (calls) => ({
  profile: 'hosted-simple',
  start: async () => calls.push('workflow:start'),
  health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
  stop: async () => calls.push('workflow:stop'),
})

const restateEndpointFake = (calls) => ({
  create: async () => ({
    run: async () => calls.push('endpoint:start'),
    shutdown: async () => calls.push('endpoint:stop'),
  }),
})

describe('Local control plane embedded durable execution', () => {
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
      expect(manifest.topology.restateVersion).toBe('1.7.9')
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
      await composition.start()
      // Acceptance is wired to the queue-backed dispatcher: enqueuing through
      // the same port the Restate ingress client implements lands a job.
      await composition.workflowDispatcher.submit({
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
        executionPlan: {
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          schemaVersion: 1,
        },
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

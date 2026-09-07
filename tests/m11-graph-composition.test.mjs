import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/composition.ts'
import { HostedServerControlPlaneComposition } from '../apps/hosted-control-plane/src/composition.ts'
import { resolveHostedCompositionConfiguration } from '../apps/hosted-control-plane/src/index.ts'

test('Local, Hosted Simple and Hosted Server forward graph lifecycle operations', async () => {
  for (const profile of ['local', 'hosted-simple', 'hosted-server']) {
    const directory = await mkdtemp(join(tmpdir(), 'm11-graph-composition-'))
    const calls = []
    const graphActivities = Object.fromEntries(
      ['runGraphSegment', 'resumeGraphSegment', 'continueGraphSegment', 'cancelGraphSegment'].map(
        (operation) => [
          operation,
          async (input) => {
            calls.push({ operation, input })
            return { outcome: 'continue', checkpointId: 'checkpoint-one' }
          },
        ]
      )
    )
    const options = {
      dataDirectory: directory,
      graphActivities,
      endpointFactory: { create: async () => ({ run: async () => {}, shutdown: async () => {} }) },
    }
    const composition =
      profile === 'hosted-server'
        ? new HostedServerControlPlaneComposition(
            resolveHostedCompositionConfiguration(
              {},
              {
                ...options,
                databaseUrl: 'postgresql://app:fixture@127.0.0.1/control_plane',
                connection: { database: {}, check: async () => {}, close: async () => {} },
              }
            )
          )
        : new LocalControlPlaneComposition({
            ...options,
            profile,
            runtimeTransport: { transportKind: 'direct-local' },
          })
    try {
      const activities = composition.executionLifecycleActivities
      const input = {
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        workspaceId: 'workspace-one',
        workflowId: 'workflow-one',
        graph: { graphDefinitionId: 'graph-one' },
        threadId: 'thread-one',
        idempotencyKey: 'effect-one',
      }
      for (const operation of ['runGraphSegment', 'resumeGraphSegment', 'continueGraphSegment']) {
        expect(await activities[operation](input)).toEqual({
          outcome: 'continue',
          checkpointId: 'checkpoint-one',
        })
      }
      await activities.cancelActive({
        executionId: input.executionId,
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        effectKey: input.idempotencyKey,
        reason: 'deadline',
        graph: { workspaceId: input.workspaceId, reference: input.graph, threadId: input.threadId },
      })
      expect(calls.map(({ operation }) => operation)).toEqual([
        'runGraphSegment',
        'resumeGraphSegment',
        'continueGraphSegment',
        'cancelGraphSegment',
      ])
      expect(calls[3].input).toEqual({ ...input, reason: 'deadline' })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('Local refuses graph options that would silently be ignored', () => {
  expect(
    () =>
      new LocalControlPlaneComposition({
        dataDirectory: '/unused',
        graphActivities: {},
        activities: {},
      })
  ).toThrow('LOCAL_GRAPH_ACTIVITIES_CONFIGURATION_CONFLICT')
  expect(
    () => new LocalControlPlaneComposition({ dataDirectory: '/unused', graphActivities: {} })
  ).toThrow('LOCAL_GRAPH_RUNTIME_REQUIRED')
})

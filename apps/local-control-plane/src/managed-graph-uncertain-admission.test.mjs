import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { createLocalGraphToolFixture } from './local-graph-tool-fixture.mjs'
import { ManagedLocalGraphRuntime } from './managed-graph-runtime.ts'

// Test-only regression for local composition admission. It uses the existing local graph-tool fixture (a real
// SQLite store and published graph) and the existing execution lifecycle test API. It changes no production code.

function localRuntime(fixture) {
  return new ManagedLocalGraphRuntime(fixture.persistence, {
    capabilities: ['graph.tool-pins.v1'],
    compiler: {
      operationAllowlist: [{ kind: 'tool', name: 'store' }],
      schemaRegistry: {
        getValidator(reference) {
          if (reference === 'schema:json' || reference === 'local.graph-json-object.v1') {
            return (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
          }
          if (reference === 'local.graph-state.v1') {
            return (value) => value !== null && typeof value === 'object'
          }
          return undefined
        },
      },
      maximumSteps: 8,
    },
    operations: {
      async invoke() {
        return { value: 'unused' }
      },
      async cancel() {
        return true
      },
    },
  })
}

function admissionFor(fixture, idempotencyKey) {
  return {
    executionId: fixture.operation.executionId,
    attemptId: fixture.operation.attemptId,
    workspaceId: fixture.operation.workspaceId,
    workflowId: fixture.operation.workflowId,
    graph: fixture.graph.reference,
    threadId: fixture.operation.threadId,
    input: fixture.plan.graph.input,
    idempotencyKey,
  }
}

// The execution lifecycle records the uncertain effect as reconciliation_required. This is the retained state.
async function retainUncertainEffect(fixture) {
  const lifecycle = new ExecutionLifecycleService(fixture.api.executions)
  const execution = await fixture.api.executions.getExecution(fixture.operation.executionId)
  return lifecycle.transitionExecution({
    executionId: fixture.operation.executionId,
    expectedVersion: execution.version,
    to: 'reconciliation_required',
    transitionedAt: fixture.at,
  })
}

describe('local composition admission with a retained uncertain legacy effect (M16.03, #940)', () => {
  test('admission for an execution that retains an uncertain effect is refused by the local composition', async () => {
    const fixture = await createLocalGraphToolFixture()
    try {
      const activities = localRuntime(fixture).activities(fixture.api)
      await retainUncertainEffect(fixture)
      const outcome = await activities
        .runGraphSegment(admissionFor(fixture, 'uncertain:retained:admission'))
        .then(
          (result) => ({ resolved: result }),
          (error) => ({ rejected: error })
        )
      expect(outcome).toMatchObject({
        rejected: { code: 'LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED' },
      })
    } finally {
      fixture.persistence.close()
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  test('admission is not refused once the execution lifecycle test API reconciles the uncertain effect', async () => {
    const fixture = await createLocalGraphToolFixture()
    try {
      const activities = localRuntime(fixture).activities(fixture.api)
      const retained = await retainUncertainEffect(fixture)
      await new ExecutionLifecycleService(fixture.api.executions).transitionExecution({
        executionId: fixture.operation.executionId,
        expectedVersion: retained.version,
        to: 'cancelled',
        transitionedAt: fixture.at,
      })
      const outcome = await activities
        .runGraphSegment(admissionFor(fixture, 'uncertain:reconciled:admission'))
        .then(
          (result) => ({ resolved: result }),
          (error) => ({ rejected: error })
        )
      expect(outcome.rejected?.code).not.toBe('LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED')
    } finally {
      fixture.persistence.close()
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})

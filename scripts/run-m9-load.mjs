import { createHash } from 'node:crypto'
import {
  DurableFailureHarness,
  runLoadProfile,
} from '../packages/production-readiness/src/index.ts'
import { createTelemetry } from '../packages/telemetry/src/index.ts'

const commonBudgets = {
  p95LatencyMs: 100,
  minimumThroughputPerSecond: 1_000,
  maximumErrorRate: 0,
  maximumMemoryDeltaBytes: 64 * 1024 * 1024,
  maximumCostPerOperationUsd: 0.02,
  maximumAttemptsPerOperation: 1,
}

const telemetry = createTelemetry({ serviceName: 'load-fixture' })
const profiles = [
  profile('control-api-command-read', ({ sequence }) => digest({ sequence, action: 'read' })),
  profile('restate-workflow-replay', ({ sequence }) =>
    digest({ sequence, plan: `sha256:${'a'.repeat(64)}`, state: 'running' })
  ),
  profile('event-delivery', ({ sequence }) =>
    structuredClone({
      sequence,
      kind: 'execution.progressed',
      payload: { percent: sequence % 100 },
    })
  ),
  profile('runtime-gateway-command', ({ sequence }) => {
    const harness = new DurableFailureHarness()
    harness.execute({
      commandId: `command-${sequence}`,
      payloadDigest: `sha256:${sequence.toString(16).padStart(64, '0')}`,
    })
  }),
  profile('runtime-routing', ({ sequence }) =>
    Array.from({ length: 16 }, (_, index) => ({
      id: `runtime-${index}`,
      priority: (sequence + index) % 7,
    })).toSorted((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
  ),
  profile(
    'model-tool-stream',
    ({ sequence }) =>
      JSON.stringify(
        Array.from({ length: 32 }, (_, index) => ({
          sequence: index,
          delta: `${sequence}:${index}`,
        }))
      ),
    0.004
  ),
  profile(
    'multi-agent-fanout',
    ({ sequence }) =>
      Array.from({ length: 8 }, (_, index) => ({
        parent: sequence,
        child: index,
        budgetMicrounits: 100_000,
      })),
    0.008
  ),
  profile('telemetry-control', ({ sequence }) => digest({ sequence, action: 'instrumented' })),
  profile('telemetry-instrumented', ({ sequence }) => {
    const span = telemetry.startSpan('execution.root', { executionId: `execution-${sequence}` })
    digest({ sequence, action: 'instrumented' })
    span.end({ status: 'ok' })
  }),
]

const results = []
for (const { costUsd, operation, profileId } of profiles) {
  results.push(
    await runLoadProfile(
      { profileId, iterations: 2_000, concurrency: 32, budgets: commonBudgets },
      async (input) => {
        operation(input)
        return { costUsd, attempts: 1 }
      }
    )
  )
}

for (const result of results) console.log(JSON.stringify(result))
const failed = results.filter(({ status }) => status === 'failed')
if (failed.length > 0) {
  throw new Error(`M9 load budgets failed: ${failed.map(({ profileId }) => profileId).join(', ')}`)
}

const telemetryControl = results.find(({ profileId }) => profileId === 'telemetry-control')
const telemetryInstrumented = results.find(
  ({ profileId }) => profileId === 'telemetry-instrumented'
)
if (!telemetryControl || !telemetryInstrumented) throw new Error('Telemetry load profiles missing')
const telemetryOverheadP50Ms = Math.max(
  0,
  telemetryInstrumented.p50LatencyMs - telemetryControl.p50LatencyMs
)
console.log(
  JSON.stringify({
    profileId: 'telemetry-overhead',
    p50LatencyMs: telemetryOverheadP50Ms,
    maximumP50LatencyMs: 2,
    status: telemetryOverheadP50Ms <= 2 ? 'passed' : 'failed',
  })
)
if (telemetryOverheadP50Ms > 2) throw new Error('Telemetry p50 overhead budget failed')

function profile(profileId, operation, costUsd = 0) {
  return { profileId, operation, costUsd }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

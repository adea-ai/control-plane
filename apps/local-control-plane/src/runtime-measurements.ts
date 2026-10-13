import { Worker } from 'node:worker_threads'
import { OperationsMeasurementLifecycle, type MetricAdapter } from '@control-plane/telemetry'
import {
  OperationsMeasurementBaselineSchema,
  operationsMeasurementOptionsSchema,
  type OperationsMeasurementOptions,
} from './operator-measurements.js'
import type { OperationsMetricPoint } from '@control-plane/telemetry'

export function runtimeMeasurementWorkerUrl(): URL {
  // Bun source execution must not race a build rewriting the dist worker.
  if (process.versions['bun'] !== undefined && import.meta.url.endsWith('.ts'))
    return new URL('./runtime-measurements-worker.ts', import.meta.url)
  return new URL(
    import.meta.url.endsWith('.ts')
      ? '../dist/runtime-measurements-worker.js'
      : './runtime-measurements-worker.js',
    import.meta.url
  )
}

interface WorkerResult {
  readonly points: readonly OperationsMetricPoint[]
  readonly baselineReport?: unknown
}

function sampleInWorker(
  databasePath: string,
  measurement: OperationsMeasurementOptions
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(runtimeMeasurementWorkerUrl(), {
      workerData: { databasePath, measurement },
    })
    let result: WorkerResult | undefined
    let failed = false
    worker.on('message', (message: { ok: boolean; result?: WorkerResult }) => {
      if (!message.ok || result !== undefined) failed = true
      else result = message.result
    })
    worker.on('error', () => {
      failed = true
    })
    // A posted result is not proof that Bun released the SQLite statements.
    // Wait for the thread to exit before emission or persistence shutdown.
    worker.once('exit', (code) => {
      if (code !== 0 || failed || result === undefined)
        reject(new Error('RUNTIME_MEASUREMENTS_WORKER_FAILED'))
      else resolve(result)
    })
  })
}

export interface LocalRuntimeMeasurementsOptions {
  readonly databasePath: string
  readonly adapter: MetricAdapter
  readonly intervalMs: number
  readonly measurement: Omit<OperationsMeasurementOptions, 'baselineReport' | 'now'>
  readonly now?: () => Date
}

/**
 * Local/Hosted Simple SQLite adapter. Open a separate read-only handle for each
 * pass in a worker so no measurement observes uncommitted application writes. A read
 * transaction holds one consistent WAL snapshot across all report namespaces.
 * Retain only the complete storage baseline, never correlation rows or payloads.
 */
export function createLocalRuntimeMeasurements(
  options: LocalRuntimeMeasurementsOptions
): OperationsMeasurementLifecycle {
  const measurement = operationsMeasurementOptionsSchema
    .omit({ baselineReport: true, now: true })
    .parse(options.measurement)
  let baselineReport: unknown
  return new OperationsMeasurementLifecycle({
    adapter: options.adapter,
    serviceName: 'local-control-plane',
    intervalMs: options.intervalMs,
    measure: async () => {
      const result = await sampleInWorker(options.databasePath, {
        ...measurement,
        now: (options.now?.() ?? new Date()).toISOString(),
        ...(baselineReport === undefined ? {} : { baselineReport }),
      })
      if (result.baselineReport !== undefined)
        baselineReport = OperationsMeasurementBaselineSchema.parse(result.baselineReport)
      return result.points
    },
  })
}

import { DatabaseSync } from 'node:sqlite'
import { OperationsMeasurementLifecycle, type MetricAdapter } from '@control-plane/telemetry'
import {
  createSqliteMeasurementReader,
  measureOperations,
  OperationsMeasurementBaselineSchema,
  operationsMeasurementOptionsSchema,
  type OperationsMeasurementOptions,
} from './operator-measurements.js'

export interface LocalRuntimeMeasurementsOptions {
  readonly databasePath: string
  readonly adapter: MetricAdapter
  readonly intervalMs: number
  readonly measurement: Omit<OperationsMeasurementOptions, 'baselineReport' | 'now'>
  readonly now?: () => Date
}

/**
 * Local/Hosted Simple SQLite adapter. Open a separate read-only handle for each
 * pass so no measurement observes uncommitted application writes. A read
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
    measure: () => {
      const database = new DatabaseSync(options.databasePath, { readOnly: true })
      try {
        database.exec('BEGIN')
        const report = measureOperations(createSqliteMeasurementReader(database), {
          ...measurement,
          now: (options.now?.() ?? new Date()).toISOString(),
          ...(baselineReport === undefined ? {} : { baselineReport }),
        })
        database.exec('COMMIT')
        if (report.measurements.storage.complete) {
          baselineReport = OperationsMeasurementBaselineSchema.parse(report)
        }
        return report.telemetry
      } finally {
        database.close()
      }
    },
  })
}

import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
// Node worker_threads uses a transfer list, not the browser targetOrigin argument.
/* oxlint-disable unicorn/require-post-message-target-origin */
import {
  createSqliteMeasurementReader,
  measureOperations,
  OperationsMeasurementBaselineSchema,
} from './operator-measurements.js'

let database: DatabaseSync | undefined
try {
  database = new DatabaseSync(workerData.databasePath, { readOnly: true })
  database.exec('BEGIN')
  const report = measureOperations(createSqliteMeasurementReader(database), workerData.measurement)
  database.exec('COMMIT')
  const points = report.telemetry.map(({ name, value, labels }) => ({
    name,
    value,
    ...(labels === undefined ? {} : { labels }),
  }))
  // Only aggregate points and a compact complete baseline cross the boundary.
  parentPort?.postMessage({
    ok: true,
    result: {
      points,
      ...(report.measurements.storage.complete
        ? { baselineReport: OperationsMeasurementBaselineSchema.parse(report) }
        : {}),
    },
  })
} catch {
  parentPort?.postMessage({ ok: false })
} finally {
  try {
    database?.close()
  } finally {
    parentPort?.close()
  }
}

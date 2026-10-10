import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  MAX_CORRELATION_LIMIT,
  MAX_STORAGE_USD_PER_GIB_MONTH,
  MAX_WINDOW_SECONDS,
  MIN_STORAGE_USD_PER_GIB_MONTH,
  MIN_WINDOW_SECONDS,
  createSqliteMeasurementReader,
  measureOperations,
} from './operator-measurements.js'
import {
  openReadOnlyInspectionDatabase,
  type InspectionDatabaseHandle,
} from './operator-inspection.js'

// Offline operator authority is possession of the private database directory.
// This command is strictly read-only: the operator database is either opened
// with SQLite `readOnly` or byte-copied into a private snapshot that carries
// `query_only`, nothing is migrated, and only parameterized SELECT statements
// run. It never retries, cancels, reconciles or redeploys anything, it never
// grants credentials or approvals, and it infers no provider cost: storage is
// priced only when the operator passes an explicit USD rate.
let database: InspectionDatabaseHandle | undefined
try {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      workspace: { type: 'string' },
      'window-seconds': { type: 'string' },
      limit: { type: 'string' },
      'storage-usd-per-gib-month': { type: 'string' },
      'baseline-report': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const directory = values['data-dir']
  if (!directory || !values.workspace || !isAbsolute(directory))
    throw new Error('INVALID_ARGUMENTS')
  const workspaceId = IdentifierSchemas.workspaceId.parse(values.workspace)
  const windowSeconds =
    values['window-seconds'] === undefined
      ? undefined
      : zParseNumber(
          values['window-seconds'],
          MIN_WINDOW_SECONDS,
          MAX_WINDOW_SECONDS,
          'INVALID_WINDOW'
        )
  const limit =
    values.limit === undefined
      ? undefined
      : zParseNumber(values.limit, 1, MAX_CORRELATION_LIMIT, 'INVALID_LIMIT')
  const storageUsdPerGiBMonth =
    values['storage-usd-per-gib-month'] === undefined
      ? undefined
      : zParseRate(
          values['storage-usd-per-gib-month'],
          MIN_STORAGE_USD_PER_GIB_MONTH,
          MAX_STORAGE_USD_PER_GIB_MONTH,
          'INVALID_STORAGE_RATE'
        )
  // The baseline is a prior measurement report the operator already holds —
  // never a second look at the operator database. A malformed baseline or one
  // from another workspace fails closed instead of producing a misleading
  // growth delta.
  const baselineReport =
    values['baseline-report'] === undefined
      ? undefined
      : JSON.parse(await readFile(values['baseline-report'], 'utf8'))
  const directoryStat = await lstat(directory)
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && directoryStat.uid !== process.getuid())
  )
    throw new Error('INVALID_TARGET')
  const databasePath = join(directory, 'control-plane.sqlite')
  const databaseStat = await lstat(databasePath)
  if (
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    (databaseStat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && databaseStat.uid !== process.getuid())
  )
    throw new Error('INVALID_TARGET')
  database = await openReadOnlyInspectionDatabase(databasePath)
  const report = measureOperations(createSqliteMeasurementReader(database), {
    workspaceId,
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    ...(limit === undefined ? {} : { limit }),
    ...(storageUsdPerGiBMonth === undefined ? {} : { storageUsdPerGiBMonth }),
    ...(baselineReport === undefined ? {} : { baselineReport }),
  })
  process.stdout.write(JSON.stringify(report) + '\n')
} catch {
  process.stderr.write('LOCAL_OPERATOR_MEASUREMENTS_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    database?.close()
  } catch {
    process.stderr.write('LOCAL_OPERATOR_MEASUREMENTS_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}

function zParseNumber(raw: string, min: number, max: number, code: string): number {
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(code)
  return parsed
}

function zParseRate(raw: string, min: number, max: number, code: string): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(code)
  return parsed
}

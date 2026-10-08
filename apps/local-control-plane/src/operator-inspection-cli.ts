import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  createSqliteRecordReader,
  inspectStuckJobs,
  MAX_RESULT_LIMIT,
  MAX_STALE_AFTER_SECONDS,
  MIN_STALE_AFTER_SECONDS,
  openReadOnlyInspectionDatabase,
  type InspectionDatabaseHandle,
} from './operator-inspection.js'

// Offline operator authority is possession of the private database directory.
// This command is strictly read-only: the operator database is either opened
// with SQLite `readOnly` or byte-copied into a private snapshot that carries
// `query_only`, nothing is migrated, and only parameterized SELECT statements
// run. It never retries, cancels, reconciles or redeploys anything, and it
// never grants service credentials, catalog approval or context access.
let database: InspectionDatabaseHandle | undefined
try {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      workspace: { type: 'string' },
      project: { type: 'string' },
      profile: { type: 'string' },
      limit: { type: 'string' },
      'stale-after-seconds': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const directory = values['data-dir']
  if (!directory || !values.workspace || !isAbsolute(directory))
    throw new Error('INVALID_ARGUMENTS')
  const workspaceId = IdentifierSchemas.workspaceId.parse(values.workspace)
  const projectId =
    values.project === undefined ? undefined : IdentifierSchemas.projectId.parse(values.project)
  const profileId =
    values.profile === undefined ? undefined : IdentifierSchemas.profileId.parse(values.profile)
  const limit =
    values.limit === undefined
      ? undefined
      : zParseNumber(values.limit, 1, MAX_RESULT_LIMIT, 'INVALID_LIMIT')
  const staleAfterSeconds =
    values['stale-after-seconds'] === undefined
      ? undefined
      : zParseNumber(
          values['stale-after-seconds'],
          MIN_STALE_AFTER_SECONDS,
          MAX_STALE_AFTER_SECONDS,
          'INVALID_STALE_AFTER'
        )
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
  const report = inspectStuckJobs(createSqliteRecordReader(database), {
    workspaceId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(profileId === undefined ? {} : { profileId }),
    ...(limit === undefined ? {} : { limit }),
    ...(staleAfterSeconds === undefined ? {} : { staleAfterSeconds }),
  })
  process.stdout.write(JSON.stringify(report) + '\n')
} catch {
  process.stderr.write('LOCAL_OPERATOR_INSPECTION_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    database?.close()
  } catch {
    process.stderr.write('LOCAL_OPERATOR_INSPECTION_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}

function zParseNumber(raw: string, min: number, max: number, code: string): number {
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(code)
  return parsed
}

import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { IdentifierSchemas } from '@control-plane/contracts'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  clearWorkflowAdmissionStop,
  setWorkflowAdmissionStop,
} from './operator-admission-controls.js'

// Offline operator authority is possession of the private database directory.
// The actor principal and command identity come from the input document and
// are validated by the same rules the online path enforces: a principal that
// does not parse, or that does not hold the target workspace, fails closed
// without touching admission state. This command only pauses or resumes NEW
// workflow-job admission for one workspace; it never cancels, retries,
// reconciles or redeploys anything, and it never grants credentials or
// approvals.
let persistence: SqlitePersistenceProvider | undefined
try {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      action: { type: 'string' },
      workspace: { type: 'string' },
      input: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const directory = values['data-dir']
  const action = values.action
  if (
    !directory ||
    !isAbsolute(directory) ||
    (action !== 'stop' && action !== 'resume') ||
    !values.workspace ||
    !values.input ||
    !isAbsolute(values.input)
  )
    throw new Error('INVALID_ARGUMENTS')
  const workspaceId = IdentifierSchemas.workspaceId.parse(values.workspace)
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
  const file = await open(
    values.input,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  let document: unknown
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('INVALID_INPUT')
    const bytes = Buffer.alloc(262145)
    let count = 0
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count)
      if (read.bytesRead === 0) break
      count += read.bytesRead
    }
    if (count > 262144) throw new Error('INVALID_INPUT')
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
    )
  } finally {
    await file.close()
  }
  const body =
    document !== null && typeof document === 'object' && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : undefined
  if (body === undefined || !('reasonClass' in body)) throw new Error('INVALID_INPUT')
  const command = {
    ...body,
    scope: { kind: 'workspace', workspaceId },
  }
  persistence = new SqlitePersistenceProvider({ path: databasePath })
  await persistence.migrate()
  const outcome =
    action === 'stop'
      ? await setWorkflowAdmissionStop(persistence, command)
      : await clearWorkflowAdmissionStop(persistence, command)
  process.stdout.write(JSON.stringify({ action, workspaceId, ...outcome }) + '\n')
} catch {
  process.stderr.write('LOCAL_OPERATOR_ADMISSION_CONTROLS_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    persistence?.close()
  } catch {
    process.stderr.write('LOCAL_OPERATOR_ADMISSION_CONTROLS_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}

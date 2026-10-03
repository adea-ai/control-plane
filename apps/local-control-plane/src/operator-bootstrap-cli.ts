import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { bootstrapLocalOperator } from './operator-bootstrap.js'

// Offline operator authority is possession of the private database directory.
// This command never grants service credentials, catalog approval or context access.
let persistence: SqlitePersistenceProvider | undefined
try {
  const { values } = parseArgs({
    options: { 'data-dir': { type: 'string' }, input: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  const directory = values['data-dir']
  if (!directory || !values.input || !isAbsolute(directory) || !isAbsolute(values.input))
    throw new Error('INVALID_ARGUMENTS')
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
  let input: unknown
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
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
  } finally {
    await file.close()
  }
  persistence = new SqlitePersistenceProvider({ path: databasePath })
  await persistence.migrate()
  const result = await bootstrapLocalOperator(persistence, input)
  process.stdout.write(JSON.stringify(result) + '\n')
} catch {
  process.stderr.write('LOCAL_OPERATOR_BOOTSTRAP_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    persistence?.close()
  } catch {
    process.stderr.write('LOCAL_OPERATOR_BOOTSTRAP_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}

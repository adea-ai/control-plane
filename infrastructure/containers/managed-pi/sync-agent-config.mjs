import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const configFiles = ['auth.json', 'models.json', 'settings.json']
const [sourceDirectory, runtimeDirectory, ...extraArguments] = process.argv.slice(2)

class ConfigSyncError extends Error {}

function fail(code) {
  throw new ConfigSyncError(code)
}

async function statIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function removeIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function main() {
  if (!sourceDirectory || !runtimeDirectory || extraArguments.length !== 0)
    fail('MANAGED_PI_CONFIG_SYNC_ARGUMENTS_INVALID')

  const sourceStats = await statIfPresent(sourceDirectory)
  if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink())
    fail('MANAGED_PI_CONFIG_SOURCE_NOT_DIRECTORY')
  if ((sourceStats.mode & 0o077) !== 0) fail('MANAGED_PI_CONFIG_SOURCE_NOT_PRIVATE')

  let runtimeStats = await statIfPresent(runtimeDirectory)
  if (!runtimeStats) {
    await mkdir(runtimeDirectory, { mode: 0o700 })
    runtimeStats = await lstat(runtimeDirectory)
  }
  if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink())
    fail('MANAGED_PI_RUNTIME_DIRECTORY_NOT_DIRECTORY')
  if (runtimeStats.uid !== process.getuid() || (runtimeStats.mode & 0o077) !== 0)
    fail('MANAGED_PI_RUNTIME_DIRECTORY_NOT_PRIVATE')

  const entries = []
  for (const name of configFiles) {
    const sourcePath = join(sourceDirectory, name)
    const runtimePath = join(runtimeDirectory, name)
    const sourceStat = await statIfPresent(sourcePath)
    const runtimeStat = await statIfPresent(runtimePath)
    if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink()))
      fail('MANAGED_PI_CONFIG_SOURCE_NOT_REGULAR')
    if (sourceStat && (sourceStat.mode & 0o077) !== 0)
      fail('MANAGED_PI_CONFIG_SOURCE_FILE_NOT_PRIVATE')
    if (runtimeStat && (!runtimeStat.isFile() || runtimeStat.isSymbolicLink()))
      fail('MANAGED_PI_RUNTIME_CONFIG_NOT_REGULAR')
    entries.push({ name, sourcePath, runtimePath, sourceExists: Boolean(sourceStat) })
  }

  const staged = []
  try {
    for (const entry of entries) {
      if (!entry.sourceExists) continue
      const source = await open(entry.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const temporaryPath = join(
        runtimeDirectory,
        `.${entry.name}.${process.pid}.${randomUUID()}.tmp`
      )
      const stagedEntry = { ...entry, temporaryPath }
      staged.push(stagedEntry)
      let destination
      try {
        const sourceStat = await source.stat()
        if (!sourceStat.isFile() || (sourceStat.mode & 0o077) !== 0)
          fail('MANAGED_PI_CONFIG_SOURCE_NOT_REGULAR')
        const content = await source.readFile()
        destination = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        )
        await destination.writeFile(content)
        await destination.chmod(0o600)
        await destination.sync()
      } finally {
        await source.close()
        await destination?.close()
      }
    }

    for (const entry of staged) await rename(entry.temporaryPath, entry.runtimePath)
    for (const entry of entries) {
      if (!entry.sourceExists) await removeIfPresent(entry.runtimePath)
    }
  } finally {
    for (const entry of staged) await removeIfPresent(entry.temporaryPath)
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof ConfigSyncError ? error.message : 'MANAGED_PI_CONFIG_SYNC_FAILED')
  process.exitCode = 78
}

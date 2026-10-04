import { lstat, realpath, readFile, readdir, unlink, rmdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Only remove the direct, exclusively created CI fixture with its matching owner marker.
 * Walk without following links; caller data and Compose projects are never adopted.
 */
export async function removeHostedComposeFixture(runnerTemp, fixture, project) {
  if (!runnerTemp || !fixture || !project || !/^control-plane-m10-\d+-\d+-[a-z0-9]+$/.test(project))
    throw new Error('HOSTED_COMPOSE_FIXTURE_OWNER_INVALID')
  const root = resolve(fixture)
  if (
    root !== fixture ||
    !/^control-plane-m10-compose\.[A-Za-z0-9]+$/.test(basename(root)) ||
    (await lstat(root)).isSymbolicLink() ||
    (await realpath(dirname(root))) !== (await realpath(runnerTemp))
  )
    throw new Error('HOSTED_COMPOSE_FIXTURE_SCOPE_INVALID')
  const marker = join(root, '.fixture-owner.json')
  if (
    (await lstat(marker)).isSymbolicLink() ||
    JSON.parse(await readFile(marker, 'utf8')).project !== project
  )
    throw new Error('HOSTED_COMPOSE_FIXTURE_OWNER_INVALID')
  const remove = async (directory) => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      if (path === marker) continue
      const stat = await lstat(path)
      if (stat.isDirectory() && !stat.isSymbolicLink()) await remove(path)
      else await unlink(path)
    }
    if (directory !== root) await rmdir(directory)
  }
  await remove(root)
  await unlink(marker)
  await rmdir(root)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await removeHostedComposeFixture(...process.argv.slice(2))
  } catch {
    console.error('Hosted Compose fixture removal failed; verify the recorded owner and directory.')
    process.exitCode = 1
  }
}

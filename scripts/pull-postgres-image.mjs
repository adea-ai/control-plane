import { spawnSync as defaultSpawnSync } from 'node:child_process'
import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWithPullBackoff } from './docker-pull-backoff.mjs'

const pullArguments = ['compose', 'pull', 'postgres']

export async function pullPostgresImage({
  spawnSync = defaultSpawnSync,
  cwd = process.cwd(),
  environment = process.env,
  backoffOptions,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const result = await runWithPullBackoff(
    () =>
      spawnSync('docker', pullArguments, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        env: environment,
        timeout: 90_000,
      }),
    {
      ...backoffOptions,
      onAttempt: (attempt) => {
        if (attempt.stdout) stdout.write(attempt.stdout)
        if (attempt.stderr) stderr.write(attempt.stderr)
      },
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker compose pull postgres exited with status ${String(result.status)}`)
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await pullPostgresImage()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

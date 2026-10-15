import { spawnSync as defaultSpawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  composePostgresImages,
  postgresImageVariable,
  runWithPullFallback,
} from './docker-pull-backoff.mjs'

const pullArguments = ['compose', 'pull', 'postgres']

// The canonical pinned reference from the compose file in `cwd`, or undefined when there is none
// to read. Without it only the bounded backoff applies.
function canonicalImage(cwd, environment) {
  if (environment[postgresImageVariable]) return environment[postgresImageVariable]
  try {
    return composePostgresImages(readFileSync(join(cwd, 'compose.yaml'), 'utf8'))[0]
  } catch {
    return undefined
  }
}

// Resolves to the pull result plus `image`: the fallback reference that was pulled when the
// canonical registry was rate limited, or undefined when the compose file's own image was pulled.
// A caller that starts the service afterwards must export that reference as
// CONTROL_PLANE_POSTGRES_IMAGE so compose uses the image that is now present locally.
export async function pullPostgresImage({
  spawnSync = defaultSpawnSync,
  cwd = process.cwd(),
  environment = process.env,
  backoffOptions,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const run = (arguments_) =>
    spawnSync('docker', arguments_, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: environment,
      timeout: 90_000,
    })
  const { result, image } = await runWithPullFallback(
    (fallback) => {
      // A fallback was already pulled by runWithPullFallback.
      if (fallback !== undefined) return { status: 0, stdout: '', stderr: '' }
      const attempt = run(pullArguments)
      if (attempt.stdout) stdout.write(attempt.stdout)
      if (attempt.stderr) stderr.write(attempt.stderr)
      return attempt
    },
    canonicalImage(cwd, environment),
    { pull: (reference) => run(['pull', '--quiet', reference]), ...backoffOptions }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker compose pull postgres exited with status ${String(result.status)}`)
  }
  return { ...result, image }
}

// Later steps of the same GitHub job start Postgres from their own shell, so the selected fallback
// reference is handed over through the job environment file.
export function exportSelectedImage(
  image,
  { environment = process.env, append = appendFileSync } = {}
) {
  if (image === undefined || !environment.GITHUB_ENV) return false
  append(environment.GITHUB_ENV, `${postgresImageVariable}=${image}\n`)
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--print-image` prints the selected fallback reference (empty for the canonical image) on
  // stdout, so a shell caller can export it; docker's own output then goes to stderr.
  const printImage = process.argv.includes('--print-image')
  try {
    const { image } = await pullPostgresImage({
      stdout: printImage ? process.stderr : process.stdout,
    })
    exportSelectedImage(image)
    if (printImage) process.stdout.write(`${image ?? ''}\n`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

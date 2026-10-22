import { spawnSync as defaultSpawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  postgresImageVariable,
  pullInterruptedMessage,
  runWithPullFallback,
} from './docker-pull-backoff.mjs'

const pullArguments = ['compose', 'pull', 'postgres']
const configArguments = ['compose', 'config', '--format', 'json', 'postgres']

// The configuration and pull commands are SYNCHRONOUS: while one of them runs it
// holds the event loop, so a signal delivered during it is only processed on a
// later turn — after the next interruption check would already have read the
// state from BEFORE the signal and started another command. Yielding one turn
// closes that window: `setImmediate` resumes after the poll phase of the
// current iteration, which is where a pending signal is dispatched, so the
// interruption state read after it is the state the process already has.
const settlePendingSignal = () => new Promise((resolve) => setImmediate(resolve))

// The image Compose itself resolves for the postgres service: the same working directory,
// environment, `.env` file, COMPOSE_FILE selection and overrides as the pull that follows. Anything
// short of a definite answer (Compose fails, prints something else, names no image) is `undefined`,
// and without a known image there is no fallback, only the bounded backoff. The output is only
// parsed, never printed, because a resolved configuration can carry secrets.
function effectiveImage(run, environment) {
  const result = run(configArguments, environment)
  if (result.error || result.status !== 0) return undefined
  try {
    const image = JSON.parse(result.stdout).services?.postgres?.image
    return typeof image === 'string' && image !== '' ? image : undefined
  } catch {
    return undefined
  }
}

// Resolves to the pull result plus `image`: the fallback reference that was pulled when the
// registry of the effective image was rate limited, or undefined when that image itself was pulled.
// A caller that starts the service afterwards must export that reference as
// CONTROL_PLANE_POSTGRES_IMAGE so compose uses the image that is now present locally.
export async function pullPostgresImage({
  spawnSync = defaultSpawnSync,
  cwd = process.cwd(),
  environment = process.env,
  backoffOptions,
  stdout = process.stdout,
  stderr = process.stderr,
  isInterrupted,
} = {}) {
  const run = (arguments_, env = environment) =>
    spawnSync('docker', arguments_, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      timeout: 90_000,
    })
  // No command is started after an interruption. The state is read after a turn
  // that lets a signal delivered during an earlier synchronous command run, and
  // it is read again by the loop through the same hook for every command the
  // loop may start. A caller that supplies no interruption state keeps the
  // previous behaviour exactly: no settle, no check.
  if (isInterrupted !== undefined) {
    await settlePendingSignal()
    if (isInterrupted() === true) throw new Error(pullInterruptedMessage)
  }
  const { result, image } = await runWithPullFallback(
    (fallback) => {
      // A fallback was already pulled by runWithPullFallback.
      if (fallback !== undefined) return { status: 0, stdout: '', stderr: '' }
      const attempt = run(pullArguments)
      if (attempt.stdout) stdout.write(attempt.stdout)
      if (attempt.stderr) stderr.write(attempt.stderr)
      return attempt
    },
    effectiveImage(run, environment),
    {
      pull: (reference) => {
        // The fallback only helps if exporting it makes Compose run exactly that reference. A
        // Compose override or file selection that ignores the variable would start another image.
        const selected = effectiveImage(run, { ...environment, [postgresImageVariable]: reference })
        if (selected !== reference) {
          return {
            status: 1,
            stdout: '',
            stderr: `${postgresImageVariable} does not select the postgres image in this Compose configuration`,
          }
        }
        return run(['pull', '--quiet', reference])
      },
      ...backoffOptions,
      // The interruption state is the caller's: an interrupted run must launch
      // no further pull command, and the backoff wait must end with it. The
      // settle hook is what makes that true for these synchronous commands.
      ...(isInterrupted === undefined ? {} : { isInterrupted, settlePendingSignal }),
    }
  )

  // An interrupted pull is reported as an interruption, not as a failed pull.
  if (isInterrupted !== undefined && isInterrupted() === true)
    throw new Error(pullInterruptedMessage)
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

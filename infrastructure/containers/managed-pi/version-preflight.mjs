import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PINNED_PI_VERSION = '1.0.0'
export const PI_VERSION_PREFLIGHT_TIMEOUT_MS = 30_000
export const PI_VERSION_PREFLIGHT_MAX_OUTPUT_BYTES = 16_384

const PREFLIGHT_CODES = Object.freeze({
  invalidArguments: 'PI_VERSION_PREFLIGHT_INVALID_ARGUMENTS',
  timeout: 'PI_VERSION_PREFLIGHT_TIMEOUT',
  outputTooLarge: 'PI_VERSION_PREFLIGHT_OUTPUT_TOO_LARGE',
  processError: 'PI_VERSION_PREFLIGHT_PROCESS_ERROR',
  processFailed: 'PI_VERSION_PREFLIGHT_PROCESS_FAILED',
  versionMismatch: 'PI_VERSION_PREFLIGHT_VERSION_MISMATCH',
})

function outputBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (Buffer.isBuffer(value)) return value.byteLength
  return 0
}

function outputText(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function failure(code) {
  return { ok: false, code }
}

export function preflightManagedPiVersion({
  executablePath,
  agentDirectory,
  pathValue,
  run = spawnSync,
} = {}) {
  if (
    typeof executablePath !== 'string' ||
    !isAbsolute(executablePath) ||
    typeof agentDirectory !== 'string' ||
    !isAbsolute(agentDirectory) ||
    typeof pathValue !== 'string' ||
    pathValue.length === 0
  )
    return failure(PREFLIGHT_CODES.invalidArguments)

  let result
  try {
    result = run(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: PI_VERSION_PREFLIGHT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: PI_VERSION_PREFLIGHT_MAX_OUTPUT_BYTES,
      env: {
        PATH: pathValue,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return failure(PREFLIGHT_CODES.processError)
  }

  if (result?.error?.code === 'ETIMEDOUT') return failure(PREFLIGHT_CODES.timeout)
  if (result?.error?.code === 'ENOBUFS') return failure(PREFLIGHT_CODES.outputTooLarge)
  if (result?.error !== undefined) return failure(PREFLIGHT_CODES.processError)

  if (
    outputBytes(result?.stdout) + outputBytes(result?.stderr) >
    PI_VERSION_PREFLIGHT_MAX_OUTPUT_BYTES
  )
    return failure(PREFLIGHT_CODES.outputTooLarge)

  if (result?.status !== 0) return failure(PREFLIGHT_CODES.processFailed)
  if (outputText(result.stdout).trim() !== PINNED_PI_VERSION)
    return failure(PREFLIGHT_CODES.versionMismatch)

  return { ok: true, version: PINNED_PI_VERSION }
}

const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedFile !== undefined && import.meta.url === pathToFileURL(invokedFile).href) {
  const result = preflightManagedPiVersion({
    executablePath: process.argv[2],
    agentDirectory: process.env.PI_CODING_AGENT_DIR,
    pathValue: process.env.PATH,
  })
  if (!result.ok) {
    process.stderr.write(`${result.code}\n`)
    process.exitCode = 1
  }
}

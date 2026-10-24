import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const applicationEnvironments = ['development', 'test', 'production'] as const

export type ApplicationEnvironment = (typeof applicationEnvironments)[number]
export type RawEnvironment = Readonly<Record<string, string | undefined>>

export interface EnvironmentLoadOptions {
  readonly cwd?: string
}

export function resolveApplicationEnvironment(environment: RawEnvironment): ApplicationEnvironment {
  const value = environment['APP_ENV'] ?? 'development'
  if (applicationEnvironments.some((candidate) => candidate === value)) {
    return value as ApplicationEnvironment
  }
  throw new EnvironmentNameError()
}

export async function loadEnvironment(
  baseEnvironment: RawEnvironment,
  options: EnvironmentLoadOptions = {}
): Promise<RawEnvironment> {
  const applicationEnvironment = resolveApplicationEnvironment(baseEnvironment)
  if (applicationEnvironment === 'production') {
    return { ...baseEnvironment }
  }

  const cwd = options.cwd ?? process.cwd()
  const files = [
    '.env',
    '.env.local',
    `.env.${applicationEnvironment}`,
    `.env.${applicationEnvironment}.local`,
  ]
  const loaded: Record<string, string | undefined> = {}
  for (const file of files) Object.assign(loaded, await readEnvironmentFile(join(cwd, file)))
  return { ...loaded, ...baseEnvironment }
}

async function readEnvironmentFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissingFileError(error)) return {}
    throw error
  }
}

function parseEnvironmentFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, sourceValue] = match
    if (key === undefined || sourceValue === undefined) continue
    values[key] = parseEnvironmentValue(sourceValue)
  }
  return values
}

function parseEnvironmentValue(source: string): string {
  const value = source.trim()
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1)
  return value.replace(/\s+#.*$/, '').trim()
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export class EnvironmentNameError extends Error {
  constructor() {
    super('APP_ENV must be one of development, test, or production')
    this.name = 'EnvironmentNameError'
  }
}

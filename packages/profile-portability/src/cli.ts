#!/usr/bin/env node

import { chmod, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  applyPortableImport,
  assertPortableManifest,
  exportPortableState,
  planPortableImport,
  type PortableImportPlan,
} from './index.js'

type LocalProfile = 'local' | 'hosted-simple'
const MAX_SENSITIVE_VALUES_FILE_BYTES = 4 * 1024 * 1024

interface CliIo {
  readonly stdout: (value: string) => void
  readonly stderr: (value: string) => void
}

export async function runPortabilityCli(
  arguments_: readonly string[],
  io: CliIo = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
  }
): Promise<number> {
  try {
    const [command, ...rest] = arguments_
    const flags = parseFlags(rest)
    if (command === 'verify') {
      const manifest = assertPortableManifest(await readJson(required(flags, 'manifest')))
      io.stdout(JSON.stringify(summary(manifest), undefined, 2))
      return 0
    }
    if (command === 'export') {
      const provider = await openProvider(flags)
      try {
        const manifest = await exportPortableState(
          new PersistencePortableStateSource({
            persistence: provider,
            componentVersions: { contracts: '1.0.0', portability: '1.0.0' },
            activeWorkIds: () => activeWork(provider),
          }),
          {
            exportId: flags.get('export-id') ?? randomUUID(),
            includeSelectedHistory: flags.has('include-history'),
            sensitiveValues: await readSensitiveValues(flags.get('sensitive-values-file')),
          }
        )
        const output = required(flags, 'output')
        await writeJsonAtomically(output, manifest)
        io.stdout(
          JSON.stringify({ outcome: 'exported', output: resolve(output), ...summary(manifest) })
        )
      } finally {
        provider.close()
      }
      return 0
    }
    if (command === 'plan' || command === 'import') {
      const manifest = assertPortableManifest(await readJson(required(flags, 'manifest')))
      const provider = await openProvider(flags)
      try {
        const destination = new PersistencePortableStateDestination({
          persistence: provider,
          capabilities: commaSet(flags.get('capabilities')),
          secretProviders: commaSet(flags.get('secret-providers')),
        })
        const plan = await planPortableImport(manifest, destination)
        if (command === 'plan' || !flags.has('apply')) {
          io.stdout(JSON.stringify(redactedPlan(plan), undefined, 2))
          return plan.applicable ? 0 : 2
        }
        const result = await applyPortableImport(manifest, plan, destination)
        io.stdout(JSON.stringify(result, undefined, 2))
        return 0
      } finally {
        provider.close()
      }
    }
    io.stderr(usage())
    return 2
  } catch (error) {
    io.stderr(
      JSON.stringify({
        outcome: 'failed',
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'PORTABILITY_CLI_ERROR',
      })
    )
    return 1
  }
}

async function openProvider(
  flags: ReadonlyMap<string, string>
): Promise<SqlitePersistenceProvider> {
  const profile = (flags.get('profile') ?? 'local') as LocalProfile
  if (profile !== 'local' && profile !== 'hosted-simple') throw new Error('INVALID_PROFILE')
  const provider = new SqlitePersistenceProvider({
    path: required(flags, 'database'),
    profile,
  })
  await provider.migrate()
  return provider
}

async function activeWork(provider: SqlitePersistenceProvider): Promise<readonly string[]> {
  const activeStates = new Set(['accepted', 'queued', 'running', 'waiting', 'cancelling'])
  return provider.transaction(async (transaction) =>
    (await transaction.list('executions'))
      .filter(({ value }) => {
        if (!isJsonObject(value)) return false
        return activeStates.has(String(value['state'] ?? value['status'] ?? ''))
      })
      .map(({ id }) => id)
      .toSorted()
  )
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFlags(arguments_: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 1) {
    const current = arguments_[index]
    if (current === undefined || !current.startsWith('--')) throw new Error('INVALID_ARGUMENT')
    const key = current.slice(2)
    const next = arguments_[index + 1]
    if (next === undefined || next.startsWith('--')) result.set(key, 'true')
    else {
      result.set(key, next)
      index += 1
    }
  }
  return result
}

function required(flags: ReadonlyMap<string, string>, key: string): string {
  const value = flags.get(key)
  if (value === undefined || value.length === 0) throw new Error(`MISSING_${key.toUpperCase()}`)
  return value
}

function commaSet(value: string | undefined): Set<string> {
  return new Set(
    value
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  )
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
}

async function readSensitiveValues(path: string | undefined): Promise<readonly string[]> {
  if (path === undefined) return []
  const input = JSON.parse(await readBoundedFile(path, MAX_SENSITIVE_VALUES_FILE_BYTES)) as unknown
  if (
    !Array.isArray(input) ||
    input.length > 1_000 ||
    input.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 4_096)
  ) {
    throw new Error('INVALID_SENSITIVE_VALUES_FILE')
  }
  return [...new Set(input)]
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(resolve(path), 'r')
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maximumBytes) throw new Error('SENSITIVE_VALUES_FILE_TOO_LARGE')
    return buffer.subarray(0, total).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const target = resolve(path)
  const temporary = resolve(dirname(target), `.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, target)
}

function summary(manifest: ReturnType<typeof assertPortableManifest>) {
  return {
    schemaVersion: manifest.schemaVersion,
    contractVersion: manifest.contractVersion,
    exportId: manifest.exportId,
    sourceProfile: manifest.sourceProfile,
    recordCount: manifest.records.length,
    artifactCount: manifest.artifacts.length,
    secretReferenceCount: manifest.secretReferences.length,
    contentDigest: manifest.contentDigest,
  }
}

function redactedPlan(plan: PortableImportPlan) {
  return {
    schemaVersion: plan.schemaVersion,
    manifestDigest: plan.manifestDigest,
    sourceProfile: plan.sourceProfile,
    destinationProfile: plan.destinationProfile,
    applicable: plan.applicable,
    records: plan.records.map(({ record, state }) => ({
      logicalId: record.logicalId,
      category: record.category,
      revision: record.revision,
      state,
    })),
    artifactActions: plan.artifactActions.map(({ artifact, action }) => ({
      key: artifact.key,
      action,
    })),
    unresolvedSecretReferences: plan.unresolvedSecretReferences.map(({ provider, purpose }) => ({
      provider,
      purpose,
    })),
    unsupportedReferenceCount: plan.unsupportedReferences.length,
    conflicts: plan.conflicts,
  }
}

function usage(): string {
  return 'Usage: control-plane-portability <verify|export|plan|import> --manifest/--database ...; export accepts --sensitive-values-file; import is dry-run unless --apply is provided'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runPortabilityCli(process.argv.slice(2))
}

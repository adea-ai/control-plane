import type { Context } from '@earendil-works/chord'
import type {
  AnyTask,
  Cursor,
  RegistryReader,
  RegistrySnapshot,
  Storage,
} from '@earendil-works/pi-durable'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import type { CloudflareOwnerPins } from './owner.js'
import { stableJson } from './owner.js'

/** Trusted composition only; configuration identity is already admitted, never model-supplied. */
export interface CloudflareNativeTaskCatalog {
  readonly schemaVersion: 1
  readonly configurationDigest: string
  readonly registry: RegistrySnapshot
  readonly migrations: readonly {
    readonly kind: string
    readonly fromVersion: number
    readonly toVersion: number
  }[]
}
export interface CloudflarePinnedTaskCatalog {
  readonly registry: RegistryReader
  assertCompatible(kind: string, version: number): void
}
function denied(code: string): never {
  throw new RuntimeAdapterError({
    code,
    classification: 'unsupported',
    message: code,
    retryable: false,
  })
}

/** Capture definition identities and migration functions before any asynchronous boundary. */
export function pinCloudflareTaskCatalog(
  input: CloudflareNativeTaskCatalog,
  pins: CloudflareOwnerPins
): CloudflarePinnedTaskCatalog {
  if (input.schemaVersion !== 1 || input.configurationDigest !== pins.configurationDigest)
    denied('CLOUDFLARE_TASK_CATALOG_IDENTITY_UNSUPPORTED')
  const definitions = new Map<string, AnyTask>()
  for (const task of input.registry.tasks()) {
    const definition = task.definition
    if (
      !definition.name ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1 ||
      definitions.has(definition.name)
    )
      denied('CLOUDFLARE_TASK_CATALOG_INVALID')
    definitions.set(
      definition.name,
      Object.freeze({
        definition: Object.freeze({
          ...definition,
          phases: Object.freeze({ ...definition.phases }),
        }),
      })
    )
  }
  const migrations = new Set<string>()
  for (const pair of input.migrations) {
    const target = definitions.get(pair.kind)?.definition
    if (
      !target ||
      !Number.isSafeInteger(pair.fromVersion) ||
      pair.fromVersion < 1 ||
      pair.fromVersion >= pair.toVersion ||
      pair.toVersion !== target.version ||
      typeof target.migrate !== 'function'
    )
      denied('CLOUDFLARE_TASK_MIGRATION_UNSUPPORTED')
    const key = stableJson(pair)
    if (migrations.has(key)) denied('CLOUDFLARE_TASK_CATALOG_INVALID')
    migrations.add(key)
  }
  const snapshot = input.registry
  const tasks = Object.freeze([...definitions.values()])
  const pinned: RegistrySnapshot = Object.freeze({
    installed: () => snapshot.installed(),
    extension: (name: string) => snapshot.extension(name),
    tools: () => snapshot.tools(),
    sections: () => snapshot.sections(),
    tasks: () => tasks,
    task: (name: string) => definitions.get(name),
  })
  return Object.freeze({
    registry: Object.freeze({ snapshot: () => pinned, subscribe: () => () => {} }),
    assertCompatible(kind: string, version: number) {
      const target = definitions.get(kind)?.definition
      if (!target) denied('CLOUDFLARE_TASK_DEFINITION_MISSING')
      if (!Number.isSafeInteger(version) || version < 1)
        denied('CLOUDFLARE_TASK_VERSION_UNSUPPORTED')
      if (version === target.version) return
      if (!migrations.has(stableJson({ kind, fromVersion: version, toVersion: target.version })))
        denied('CLOUDFLARE_TASK_VERSION_UNSUPPORTED')
    },
  })
}

/** Read-only and bounded. Never opens Harness, invokes migration, or writes native records. */
export async function assertCloudflareTaskCompatibility(
  storage: Pick<Storage, 'scanTasks'>,
  catalog: CloudflarePinnedTaskCatalog,
  assertCurrent: () => Promise<void>,
  context: Context
): Promise<void> {
  let cursor: Cursor | undefined
  let count = 0
  const cursors = new Set<string>()
  do {
    await assertCurrent()
    const page = await storage.scanTasks({}, 64, cursor, context)
    await assertCurrent()
    if (page.items.length > 64) denied('CLOUDFLARE_TASK_SCAN_INVALID')
    count += page.items.length
    if (count > 1024) denied('CLOUDFLARE_TASK_SCAN_LIMIT')
    for (const record of page.items) {
      if (['pending', 'running', 'waiting'].includes(record.state.status))
        catalog.assertCompatible(record.kind, record.version)
      else if (!['completing', 'terminal'].includes(record.state.status))
        denied('CLOUDFLARE_TASK_STATE_UNSUPPORTED')
    }
    cursor = page.next
    if (cursor !== undefined) {
      const key = stableJson(cursor)
      if (!page.items.length || cursors.has(key)) denied('CLOUDFLARE_TASK_SCAN_INVALID')
      cursors.add(key)
      if (count === 1024) denied('CLOUDFLARE_TASK_SCAN_LIMIT')
    }
  } while (cursor !== undefined)
}

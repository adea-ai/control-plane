import { createHash } from 'node:crypto'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'

export async function insert<Value>(
  provider: PersistenceProvider,
  namespace: string,
  identity: string,
  value: Value
): Promise<boolean> {
  return provider.transaction(async (transaction) => {
    const id = recordId(identity)
    if ((await transaction.get(namespace, id)) !== undefined) return false
    await transaction.put({ namespace, id, value: json(value) })
    return true
  })
}

export async function get<Value>(
  provider: PersistenceProvider,
  namespace: string,
  identity: string,
  parse: (input: unknown) => Value
): Promise<Value | undefined> {
  return provider.transaction(async (transaction) => {
    const record = await transaction.get(namespace, recordId(identity))
    return record === undefined ? undefined : parse(record.value)
  })
}

export async function list<Value>(
  provider: PersistenceProvider,
  namespace: string,
  parse: (input: unknown) => Value
): Promise<readonly Value[]> {
  return provider.transaction(async (transaction) =>
    (await transaction.list(namespace)).map((record) => parse(record.value))
  )
}

export function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

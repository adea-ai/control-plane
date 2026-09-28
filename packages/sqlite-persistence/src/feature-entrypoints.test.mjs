import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import * as aggregate from '@control-plane/sqlite-persistence'

test('the provider entrypoint does not re-export unrelated repository graphs', async () => {
  const provider = await readFile(new URL('./provider.ts', import.meta.url), 'utf8')
  expect(provider).not.toMatch(/^export\s+\*/m)
  expect(provider).not.toMatch(/from ['"]@control-plane\/domain(?:['"]|\/)/)
  expect(provider).not.toMatch(/from ['"]\.\/.*repository/)
})

test('public operator entrypoints share the aggregate provider and repository implementations', async () => {
  const provider = await import('@control-plane/sqlite-persistence/provider')
  const catalog = await import('@control-plane/sqlite-persistence/catalog')
  const context = await import('@control-plane/sqlite-persistence/context-administration')
  expect(provider.SqlitePersistenceProvider).toBe(aggregate.SqlitePersistenceProvider)
  expect(provider.SqlitePersistenceError).toBe(aggregate.SqlitePersistenceError)
  expect(catalog.SqliteVersionedCatalogRepository).toBe(aggregate.SqliteVersionedCatalogRepository)
  expect(catalog.SqliteCatalogApprovalRepository).toBe(aggregate.SqliteCatalogApprovalRepository)
  expect(context.SqliteContextCommandGrantRepository).toBe(
    aggregate.SqliteContextCommandGrantRepository
  )
  expect(context.SqliteContextProviderRegistrationRepository).toBe(
    aggregate.SqliteContextProviderRegistrationRepository
  )
})

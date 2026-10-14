import { AsyncLocalStorage } from 'node:async_hooks'
import type { PersistenceProvider, PersistenceTransaction } from './index.js'

type Provider = Pick<PersistenceProvider, 'transaction'>
export type PersistenceReader = Pick<PersistenceTransaction, 'get' | 'list' | 'scan'>
type Scope = {
  provider: Provider
  transaction: PersistenceTransaction
  active: boolean
  pending: number
  /** Ambient ancestry; lifetime fences include only the exact provider/transaction pair. */
  parent?: Scope
}
const scopes = new AsyncLocalStorage<Scope>()

function sharesTransaction(scope: Scope, ancestor: Scope) {
  return scope.provider === ancestor.provider && scope.transaction === ancestor.transaction
}

function assertScopeActive(scope: Scope) {
  for (let ancestor: Scope | undefined = scope; ancestor; ancestor = ancestor.parent) {
    if (sharesTransaction(scope, ancestor) && !ancestor.active)
      throw new Error('PERSISTENCE_READ_SCOPE_CLOSED')
  }
}

function current(provider: Provider) {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.provider !== provider) continue
    assertScopeActive(scope)
    return scope
  }
  return undefined
}

function reader(
  transaction: PersistenceTransaction,
  assertActive: () => void,
  pendingScopes: readonly { pending: number }[]
): PersistenceReader {
  const read = async <T>(operation: () => Promise<T>) => {
    assertActive()
    for (const scope of pendingScopes) scope.pending++
    try {
      const result = await operation()
      assertActive()
      return result
    } finally {
      for (const scope of pendingScopes) scope.pending--
    }
  }
  return {
    get: (...args) => read(() => transaction.get(...args)),
    list: (...args) => read(() => transaction.list(...args)),
    scan: (...args) => read(() => transaction.scan(...args)),
  }
}

/** Server-only allocation fence. Same-provider metadata readers use the real open
 * transaction; unrelated async callers and other providers keep their own transactions.
 * The scope exposes reads only and expires before the allocation callback returns.
 */
export function withPersistenceReadScope<T>(
  provider: Provider,
  transaction: PersistenceTransaction,
  operation: () => Promise<T>
): Promise<T> {
  const ambient = scopes.getStore()
  const scope: Scope = {
    provider,
    transaction,
    active: true,
    pending: 0,
    ...(ambient ? { parent: ambient } : {}),
  }
  const ancestors: Scope[] = []
  for (let ancestor = ambient; ancestor; ancestor = ancestor.parent) {
    if (sharesTransaction(scope, ancestor)) ancestors.push(ancestor)
  }
  return scopes.run(scope, async () => {
    let tracked = false
    try {
      assertScopeActive(scope)
      // Track the entire nested callback, including awaits before its first read.
      // Every shared-transaction ancestor must remain fenced if an intermediate
      // scope returns or its refusal is caught while a deeper callback is pending.
      for (const ancestor of ancestors) ancestor.pending++
      tracked = true
      const result = await operation()
      assertScopeActive(scope)
      if (scope.pending !== 0) throw new Error('PERSISTENCE_READ_SCOPE_PENDING')
      return result
    } finally {
      scope.active = false
      if (tracked) for (const ancestor of ancestors) ancestor.pending--
    }
  })
}

export async function readPersistenceTransaction<T>(
  provider: Provider,
  operation: (transaction: PersistenceReader) => Promise<T>
): Promise<T> {
  const context = scopes.getStore()
  const scope = current(provider)
  if (!scope) {
    return provider.transaction(async (transaction) => {
      let active = true
      const pending = { pending: 0 }
      try {
        const result = await operation(
          reader(transaction, () => {
            if (!active) throw new Error('PERSISTENCE_READ_SCOPE_CLOSED')
          }, [pending])
        )
        if (pending.pending !== 0) throw new Error('PERSISTENCE_READ_SCOPE_PENDING')
        return result
      } finally {
        active = false
      }
    })
  }
  const pendingScopes: Scope[] = []
  for (
    let currentScope: Scope | undefined = scope;
    currentScope;
    currentScope = currentScope.parent
  ) {
    if (sharesTransaction(scope, currentScope)) pendingScopes.push(currentScope)
  }
  scope.pending++
  try {
    return await operation(
      reader(
        scope.transaction,
        () => {
          if (!scope.active) throw new Error('PERSISTENCE_READ_SCOPE_CLOSED')
          if (scopes.getStore() !== context || current(provider) !== scope)
            throw new Error('PERSISTENCE_READ_SCOPE_MISMATCH')
        },
        pendingScopes
      )
    )
  } finally {
    scope.pending--
  }
}

/** Metadata writes cannot join a current-authority read fence or queue behind it. */
export function writePersistenceTransaction<T>(
  provider: Provider,
  operation: (transaction: PersistenceTransaction) => Promise<T>
): Promise<T> {
  if (current(provider)) throw new Error('PERSISTENCE_READ_SCOPE_WRITE_DENIED')
  return provider.transaction(operation)
}

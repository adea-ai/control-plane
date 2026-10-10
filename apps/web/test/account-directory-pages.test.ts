/*
 * Cursor pagination for the account-wide directory and inbox (M11.03, #1174).
 * Mounted under browser-condition Solid exactly like the `@adea-ai/data`
 * resource tests; plain discovery spawns that runner.
 *
 * The load-bearing properties: pages are only ever requested by the cursor the
 * previous page returned (no unbounded fetches), loaded pages stay independent
 * of the selected workspace, and a refresh refetches exactly the pages the
 * surface holds.
 */
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'
import { accountQueryKeys, releaseWorkspaceCache } from '@adea-ai/data'
import { workspaceStore, type WorkspaceState } from '@adea-ai/state'
import { QueryClient } from '@tanstack/solid-query'
import { createRoot, createSignal } from 'solid-js'
import { isServer as isServerSolid } from 'solid-js/web'

import { createAccountDirectoryPages, createAccountInboxPages } from '../src/lib/account-directory'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))

const agent = (id: string): AccountDirectoryAgent => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  id,
  isWorkspaceLead: false,
  lifecycleState: 'active',
  name: `Agent ${id}`,
  profile: { id: `prf_${id}`, state: 'available', version: '1', revision: 1 },
  updatedAt: '2026-10-02T00:00:00.000Z',
  workspaceId: 'workspace-1',
})

/**
 * A directory API cut into cursor-addressed pages: `after` is the numeric
 * page index the previous page minted. The pages array is mutable so tests
 * can change what the server would answer next.
 */
function pagedDirectoryClient(pages: AccountDirectoryAgent[][]) {
  const calls: AccountDirectoryPageInput[] = []
  const client = {
    accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
      calls.push(input)
      const index = input.after === undefined ? 0 : Number(input.after)
      const agents = pages[index] ?? []
      return index + 1 < pages.length ? { agents, nextCursor: String(index + 1) } : { agents }
    },
  } as unknown as AccountDirectoryApiClient
  return { client, calls }
}

function mountPages(
  client: AccountDirectoryApiClient,
  baseInput?: () => AccountDirectoryPageInput
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const mounted = createRoot((rootDispose) => ({
    rootDispose,
    pages: createAccountDirectoryPages(client, {
      ...(baseInput ? { baseInput } : {}),
      queryClient,
    }),
  }))
  return { queryClient, dispose: mounted.rootDispose, pages: mounted.pages }
}

/** The inbox half of the account-wide seam: conversations instead of agents. */
function pagedInboxClient(pages: AccountConversationInboxEntry[][]) {
  const calls: AccountDirectoryPageInput[] = []
  const client = {
    accountConversationInbox: async (input: AccountDirectoryPageInput) => {
      calls.push(input)
      const index = input.after === undefined ? 0 : Number(input.after)
      const conversations = pages[index] ?? []
      return index + 1 < pages.length
        ? { conversations, nextCursor: String(index + 1) }
        : { conversations }
    },
  } as unknown as AccountDirectoryApiClient
  return { client, calls }
}

function mountInboxPages(client: AccountDirectoryApiClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const mounted = createRoot((rootDispose) => ({
    rootDispose,
    pages: createAccountInboxPages(client, { queryClient }),
  }))
  return { queryClient, dispose: mounted.rootDispose, pages: mounted.pages }
}

const isServer = isServerSolid

/** Stands in for `ApiClientError` without importing the client's internals. */
class PageFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiClientError'
  }
}

if (isServer) {
  test('browser-condition Solid runner carries the mounted pagination cases', () => {
    const child = spawnSync(
      process.execPath,
      ['--conditions=browser', '--conditions=development', 'test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 20_000, cwd: new URL('..', import.meta.url).pathname }
    )
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status, output).toBe(0)
    expect(output).toContain('0 fail')
  }, 25_000)
} else {
  const previousState: WorkspaceState = {
    ...workspaceStore.getState(),
    conversationAudienceEpochs: { ...workspaceStore.getState().conversationAudienceEpochs },
  }
  afterEach(() => workspaceStore.setState(previousState, true))

  test('the first page is bounded and load-more requests exactly the returned cursor', async () => {
    const seed = [[agent('a1'), agent('a2')], [agent('a3')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      expect(mounted.pages.isLoading()).toBe(false)
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(mounted.pages.canLoadMore()).toBe(true)
      expect(mounted.pages.exhausted()).toBe(false)
      expect(calls).toEqual([{ limit: 25 }])

      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2', 'a3'])
      // The last page returned no cursor: the list is exhausted and load-more
      // is neither offered nor able to fetch again.
      expect(mounted.pages.exhausted()).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(false)
      mounted.pages.loadMore()
      await tick()
      await tick()
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('changing the walk input restarts from the first page under the new key', async () => {
    // The authoritative search term and the archive flag are part of every
    // cache key, so a walk built before the change cannot leak rows into the
    // walk after it: the surface drops back to one page carrying the new input.
    const seed = [[agent('a1'), agent('a2')], [agent('a3')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const [term, setTerm] = createSignal('')
    const mounted = mountPages(client, () => (term() ? { q: term() } : {}))
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2', 'a3'])
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])

      setTerm('studio')
      await tick()
      await tick()
      await tick()
      // The cursor walk is over: the first page of the new term, no stale
      // `after` from the previous walk, and the old walk's rows gone.
      expect(calls.at(-1)).toEqual({ limit: 25, q: 'studio' })
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(mounted.pages.canLoadMore()).toBe(true)
      expect(mounted.pages.exhausted()).toBe(false)

      // Load-more continues the NEW walk, carrying the term on every page.
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(calls.at(-1)).toEqual({ limit: 25, q: 'studio', after: '1' })
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2', 'a3'])

      // Clearing the term restarts the walk again — and re-keys it, so the
      // termless first page is the cached one from the start of the session.
      setTerm('')
      await tick()
      await tick()
      await tick()
      expect(calls.at(-1)).toEqual({ limit: 25 })
      expect(mounted.pages.exhausted()).toBe(false)
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('a doubled load-more request cannot append the same cursor page twice', async () => {
    const seed = [[agent('a1')], [agent('a2')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      mounted.pages.loadMore()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('rows stay deduplicated when the server repeats an id across pages', async () => {
    // The keyset contract makes a repeated id a server bug; while it lasts the
    // UI must not show the row twice.
    const seed = [[agent('a1'), agent('a2')], [agent('a1')]]
    const { client } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('a failed cursor page surfaces its error, stops load-more, and refresh recovers', async () => {
    const seed = [[agent('a1')], [agent('a2')]]
    const calls: AccountDirectoryPageInput[] = []
    let failNextPage = true
    const client = {
      accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
        calls.push(input)
        if (input.after !== undefined && failNextPage) throw new PageFailure('page unavailable')
        const index = input.after === undefined ? 0 : Number(input.after)
        const agents = seed[index] ?? []
        return index + 1 < seed.length ? { agents, nextCursor: '1' } : { agents }
      },
    } as unknown as AccountDirectoryApiClient
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.error()).toBeInstanceOf(Error)
      expect(mounted.pages.canLoadMore()).toBe(false)
      // Refresh revalidates every loaded page; with the failure removed the
      // same mounted surface converges without a remount.
      failNextPage = false
      mounted.pages.refresh()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.error()).toBeUndefined()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('an empty directory first page settles exhausted with no rows and no load-more request', async () => {
    const { client, calls } = pagedDirectoryClient([[]])
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows()).toEqual([])
      expect(mounted.pages.isLoading()).toBe(false)
      expect(mounted.pages.error()).toBeUndefined()
      expect(mounted.pages.exhausted()).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(false)
      mounted.pages.loadMore()
      await tick()
      // The empty walk is complete: no cursor exists, so nothing is requested.
      expect(calls).toEqual([{ limit: 25 }])
      expect(mounted.pages.rows()).toEqual([])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('an empty inbox first page settles exhausted with no rows and no load-more request', async () => {
    const { client, calls } = pagedInboxClient([[]])
    const mounted = mountInboxPages(client)
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows()).toEqual([])
      expect(mounted.pages.error()).toBeUndefined()
      expect(mounted.pages.exhausted()).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(false)
      mounted.pages.loadMore()
      await tick()
      expect(calls).toEqual([{ limit: 25 }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('loaded pages are independent of the selected workspace and its cache release', async () => {
    const seed = [[agent('a1')], [agent('a2')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      const key = accountQueryKeys.directory({ limit: 25, after: '1' })
      expect(mounted.queryClient.getQueryData(key)).toBeDefined()

      // Switching the selected workspace releases that workspace's cache; the
      // account-wide pages sit outside the per-workspace prefix and stay, and
      // the mounted rows do not move or refetch.
      workspaceStore.getState().switchWorkspace('workspace-other')
      releaseWorkspaceCache(mounted.queryClient, 'workspace-other')
      expect(mounted.queryClient.getQueryData(key)).toBeDefined()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })
}

/*
 * The account-wide directory and inbox seam (M11.03, #1174): search patches,
 * row models, the non-leaking error copy, and the account-identity cache
 * guard. Reactive cases run only under browser-condition Solid, exactly like
 * the `@adea-ai/data` resource tests; plain discovery spawns that runner.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ApiClientError } from '@adea-ai/api-client'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type { WorkspaceSummary } from '@adea-ai/types'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
} from '@adea-ai/types/account-directory'
import { createRoot, createSignal } from 'solid-js'
import { isServer as isServerSolid } from 'solid-js/web'
import { QueryClient } from '@tanstack/solid-query'

import {
  accountWorkspaceLabel,
  clearAccountScopedCache,
  conversationOpenPatch,
  directoryAgentStatus,
  directoryErrorCopy,
  directoryTitle,
  inboxEntryLabel,
  inboxKindLabel,
  inboxUnreadModel,
  parseDirectorySection,
  unreadBadgeText,
  watchAccountIdentity,
} from '../src/lib/account-directory'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))

const agent = (overrides: Partial<AccountDirectoryAgent> = {}): AccountDirectoryAgent => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  id: 'agent-1',
  isWorkspaceLead: false,
  lifecycleState: 'active',
  name: 'Planner',
  profile: { id: 'prf_1', state: 'available', version: '1', revision: 2 },
  updatedAt: '2026-10-02T00:00:00.000Z',
  workspaceId: 'workspace-1',
  ...overrides,
})

const entry = (
  overrides: Partial<AccountConversationInboxEntry> = {}
): AccountConversationInboxEntry => ({
  agentId: 'agent-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  id: 'conversation-1',
  isPrimaryProjectChannel: false,
  kind: 'direct_agent',
  latestTopLevelSequence: 4,
  lifecycleState: 'active',
  sortOrder: 0,
  threadUnreadCount: 0,
  title: 'Planner',
  topLevelUnreadCount: 0,
  unread: false,
  unreadMentions: 0,
  updatedAt: '2026-10-02T00:00:00.000Z',
  version: 3,
  visibility: 'participants',
  workspaceId: 'workspace-1',
  ...overrides,
})

const seededClient = () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['account', 'directory', { limit: 25 }], { agents: [] })
  queryClient.setQueryData(['account', 'inbox', {}], { conversations: [] })
  queryClient.setQueryData(['account', 'summary'], {})
  queryClient.setQueryData(['workspaces', 'workspace-1', 'agents', 'list'], [])
  return queryClient
}

const isServer = isServerSolid

if (isServer) {
  test('browser-condition Solid runner carries the mounted cache-guard cases', () => {
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
  describe('directory sections and titles', () => {
    test('parses only the two real sections', () => {
      expect(parseDirectorySection('agents')).toBe('agents')
      expect(parseDirectorySection('inbox')).toBe('inbox')
      expect(parseDirectorySection('library')).toBeUndefined()
      expect(parseDirectorySection('')).toBeUndefined()
      expect(parseDirectorySection(undefined)).toBeUndefined()
    })

    test('titles name the section', () => {
      expect(directoryTitle('agents')).toBe('Agents directory')
      expect(directoryTitle('inbox')).toBe('Conversations inbox')
    })
  })

  describe('row models', () => {
    test('workspace labels stay neutral for unknown or revoked ids', () => {
      const workspaces = [{ id: 'workspace-1', name: 'Studio' }] as readonly WorkspaceSummary[]
      expect(accountWorkspaceLabel(workspaces, 'workspace-1')).toBe('Studio')
      expect(accountWorkspaceLabel([], 'workspace-revoked')).toBe('Unavailable workspace')
      // A deleted workspace among still-visible ones never resolves to another
      // workspace's name: the lookup is by id and falls back to the placeholder.
      expect(accountWorkspaceLabel(workspaces, 'workspace-deleted')).toBe('Unavailable workspace')
    })

    test('unread models sum top-level and thread counts without inventing unread', () => {
      expect(inboxUnreadModel(entry())).toEqual({ count: 0, mentions: 0, unread: false })
      expect(
        inboxUnreadModel(entry({ topLevelUnreadCount: 2, threadUnreadCount: 3, unread: true }))
      ).toEqual({ count: 5, mentions: 0, unread: true })
      expect(
        inboxUnreadModel(entry({ topLevelUnreadCount: 0, unread: true, unreadMentions: 1 }))
      ).toEqual({ count: 0, mentions: 1, unread: true })
    })

    test('badge text caps past two digits', () => {
      expect(unreadBadgeText(3)).toBe('3')
      expect(unreadBadgeText(99)).toBe('99')
      expect(unreadBadgeText(100)).toBe('99+')
    })

    test('kind labels read as words', () => {
      expect(inboxKindLabel(entry({ kind: 'direct_agent' }))).toBe('Direct')
      expect(inboxKindLabel(entry({ kind: 'group' }))).toBe('Group')
      expect(inboxKindLabel(entry({ kind: 'project' }))).toBe('Project')
    })

    test('accessible names lead with the visible title and carry unread facts', () => {
      expect(inboxEntryLabel(entry(), 'Studio')).toBe('Planner, in Studio')
      expect(
        inboxEntryLabel(entry({ title: 'Standup', unread: true, unreadMentions: 1 }), 'Studio')
      ).toBe('Standup, 1 mention, unread, in Studio')
      expect(
        inboxEntryLabel(entry({ title: 'Standup', topLevelUnreadCount: 2, unread: true }), 'Studio')
      ).toBe('Standup, 2 unread, in Studio')
    })

    test('directory Agent status never infers runtime from existence', () => {
      expect(directoryAgentStatus(agent())).toEqual({
        label: 'Configured',
        tone: 'success',
        detail: 'The selected profile version is configured.',
      })
      expect(directoryAgentStatus(agent({ lifecycleState: 'archived' })).label).toBe('Archived')
      const errorState = directoryAgentStatus(agent({ lifecycleState: 'configuration_error' }))
      expect(errorState.label).toBe('Needs configuration')
      expect(errorState.tone).toBe('warning')
      const deprecated = directoryAgentStatus(
        agent({ profile: { id: 'prf_1', state: 'deprecated', version: '1', revision: 2 } })
      )
      expect(deprecated.label).toBe('Needs configuration')
      expect(deprecated.detail).toContain('deprecated')
      const unavailable = directoryAgentStatus(
        agent({ profile: { id: 'prf_1', state: 'unavailable', version: '1', revision: 2 } })
      )
      expect(unavailable.detail).toContain('Refresh to retry')
    })
  })

  describe('conversation deep-link patch', () => {
    test('scopes the linked conversation and clears the single-surface params', () => {
      expect(
        conversationOpenPatch(entry({ id: 'conversation-9', workspaceId: 'workspace-2' }))
      ).toEqual({
        directory: undefined,
        task: undefined,
        thread: undefined,
        message: undefined,
        channel: 'conversation-9',
        workspace: 'workspace-2',
      })
    })
  })

  describe('error copy stays non-leaking', () => {
    test('maps statuses to generic sentences', () => {
      expect(directoryErrorCopy(new ApiClientError('nope', 401))).toContain('session expired')
      expect(directoryErrorCopy(new ApiClientError('nope', 403))).toContain(
        'do not have permission'
      )
      expect(directoryErrorCopy(new ApiClientError('nope', 404))).toContain('no longer available')
      expect(directoryErrorCopy(new ApiClientError('nope', 400))).toContain('was not valid')
      const generic = directoryErrorCopy(new Error('secret-project-x exploded'))
      expect(generic).not.toContain('secret-project-x')
      expect(directoryErrorCopy(undefined)).toBe(generic)
    })
  })

  describe('account-identity cache guard', () => {
    test('clears only the account-scoped entries', () => {
      const queryClient = seededClient()
      clearAccountScopedCache(queryClient)
      expect(queryClient.getQueryData(['account', 'summary'])).toBeUndefined()
      expect(queryClient.getQueryData(['account', 'directory', { limit: 25 }])).toBeUndefined()
      expect(queryClient.getQueryData(['account', 'inbox', {}])).toBeUndefined()
      expect(queryClient.getQueryData(['workspaces', 'workspace-1', 'agents', 'list'])).toEqual([])
      queryClient.clear()
    })

    test('the first observed identity is a baseline; later changes clear', async () => {
      const queryClient = seededClient()
      const [principalId, setPrincipalId] = createSignal<string | null | undefined>('user-1')
      const dispose = createRoot((rootDispose) => {
        watchAccountIdentity(queryClient, principalId)
        return rootDispose
      })
      try {
        // Baseline run: same account, nothing cleared.
        await tick()
        expect(queryClient.getQueryData(['account', 'summary'])).toEqual({})

        // A real account change wipes the account-scoped caches.
        setPrincipalId('user-2')
        await tick()
        expect(queryClient.getQueryData(['account', 'summary'])).toBeUndefined()
        expect(queryClient.getQueryData(['account', 'directory', { limit: 25 }])).toBeUndefined()
        expect(queryClient.getQueryData(['workspaces', 'workspace-1', 'agents', 'list'])).toEqual(
          []
        )

        // The same identity again clears nothing; switching to signed-out does.
        queryClient.setQueryData(['account', 'summary'], {})
        setPrincipalId('user-2')
        await tick()
        expect(queryClient.getQueryData(['account', 'summary'])).toEqual({})
        setPrincipalId(undefined)
        await tick()
        expect(queryClient.getQueryData(['account', 'summary'])).toBeUndefined()
      } finally {
        dispose()
        queryClient.clear()
      }
    })

    test('the account query options read through the account client', async () => {
      const calls: unknown[] = []
      const client = {
        accountAgentDirectory: async (input: unknown) => {
          calls.push(input)
          return { agents: [] }
        },
      } as unknown as AccountDirectoryApiClient
      const { accountQueryOptions } = await import('@adea-ai/data')
      const options = accountQueryOptions.directory(client, { limit: 25 })
      await options.queryFn()
      expect(calls).toEqual([{ limit: 25 }])
    })
  })
}

import { expect, test } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piLeadConversationAgentContextRef } from '@control-plane/contracts'
import { createProductionSourceLeadProductAuthority } from './production-source-lead-product.ts'

const id = (kind, char) => `${kind}_${char.repeat(26)}`
const uuid = (char) =>
  `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`
function fixture(database) {
  const authority = {
    schemaVersion: 'pi-lead-host-source-authority/v1',
    intentId: uuid('1'),
    host: {
      workspaceId: id('wsp', '1'),
      productWorkspaceId: uuid('2'),
      conversationId: uuid('3'),
      conversationVersion: 1,
      messageId: uuid('4'),
      messageVersion: 1,
      canonicalActorPrincipalId: `user:${uuid('5')}`,
      audienceDigest: `sha256:${'a'.repeat(64)}`,
      enlistmentGrantId: 'gra_source',
      enlistmentRevision: 1,
    },
    source: {
      workspaceId: id('wsp', '2'),
      productWorkspaceId: uuid('6'),
      agentId: id('agt', '3'),
      productAgentId: uuid('7'),
      profileId: 'source-profile',
      profileVersion: '1.0.0',
      profileRevision: 1,
    },
    contextRef: '',
  }
  authority.contextRef = piLeadConversationAgentContextRef(authority)
  const snapshot = {
    authority,
    prompt: 'Explicit host human turn',
    expiresAt: '2026-10-13T12:04:00.000Z',
  }
  const input = {
    schemaVersion: 'pi-lead-intent/v1',
    workspaceId: authority.source.workspaceId,
    intentId: authority.intentId,
    principalId: 'svc_source-test',
  }
  const state = {
    snapshot,
    hostRevoked: false,
    sourceRevoked: false,
    profileReads: [],
    modelReads: [],
    defaults: 0,
  }
  const selection = { selectionRef: `msel_${'c'.repeat(32)}`, selectionRevision: 2 }
  const options = {
    database,
    now: () => '2026-10-13T12:00:00.000Z',
    product: { readCurrent: async () => structuredClone(state.snapshot) },
    assertHostService: async (host) => {
      expect(host.workspaceId).toBe(authority.host.workspaceId)
      expect(host.principalId).toBe(input.principalId)
      if (state.hostRevoked) throw new Error('HOST_REVOKED')
    },
    assertSourceAuthority: async (source) => {
      expect(source.workspaceId).toBe(authority.source.workspaceId)
      expect(source.canonicalActorPrincipalId).toBe(authority.host.canonicalActorPrincipalId)
      if (state.sourceRevoked) throw new Error('SOURCE_REVOKED')
    },
    profiles: {
      resolveImmutable: async (pin) => {
        state.profileReads.push(pin)
        if (pin.workspaceId !== authority.source.workspaceId || pin.profileId !== 'source-profile')
          return undefined
        return {
          ...pin,
          profileVersionId: id('pfv', '4'),
          profileContentDigest: `sha256:${'b'.repeat(64)}`,
        }
      },
    },
    selections: {
      select: async (pin) => {
        state.modelReads.push(pin)
        state.defaults++
        return selection
      },
      resolveSelection: async (pin) => {
        state.modelReads.push(pin)
        return selection
      },
      assertReady: async () => {
        if (state.sourceRevoked) throw new Error('SOURCE_REVOKED')
      },
    },
    target: {
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
    },
  }
  return {
    authority,
    input,
    state,
    options,
    reader: createProductionSourceLeadProductAuthority(options),
  }
}
test('source profile/model stay source-scoped while the retained binding preserves the host conversation', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const f = fixture(database)
    const result = await f.reader.readCurrent(f.input)
    expect(result.workspaceId).toBe(f.authority.source.workspaceId)
    expect(result.principalRef).toBe(f.authority.host.canonicalActorPrincipalId)
    expect(
      f.state.profileReads.every((p) => p.workspaceId === f.authority.source.workspaceId)
    ).toBe(true)
    expect(f.state.modelReads.every((p) => p.workspaceId === f.authority.source.workspaceId)).toBe(
      true
    )
    const retained = f.reader.readRetained(f.input)
    expect(retained.authority).toEqual(f.authority)
    expect(retained.selectionRef).toBe(result.selectionRef)
    expect(retained.profileVersionId).toBe(result.profileVersionId)
  } finally {
    database.close()
  }
})
test.each(['hostRevoked', 'sourceRevoked'])(
  'current %s denies before profile/model resolution and retained replay',
  async (fault) => {
    const database = new DatabaseSync(':memory:')
    try {
      const f = fixture(database)
      f.state[fault] = true
      await expect(f.reader.readCurrent(f.input)).rejects.toThrow()
      expect(f.state.profileReads).toHaveLength(0)
      expect(f.state.modelReads).toHaveLength(0)
      f.state[fault] = false
      await f.reader.readCurrent(f.input)
      f.state[fault] = true
      await expect(f.reader.readCurrent(f.input)).rejects.toThrow()
    } finally {
      database.close()
    }
  }
)
test('host selector, missing profile and source grant loss during profile lookup cannot fall back', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const f = fixture(database)
    await expect(
      f.reader.readCurrent({ ...f.input, workspaceId: f.authority.host.workspaceId })
    ).rejects.toThrow()
    expect(f.state.modelReads).toHaveLength(0)
    f.state.snapshot.authority.source.profileId = 'host-profile'
    await expect(f.reader.readCurrent(f.input)).rejects.toThrow()
    expect(f.state.modelReads).toHaveLength(0)
    f.state.snapshot.authority.source.profileId = 'source-profile'
    f.options.profiles.resolveImmutable = async () => {
      f.state.sourceRevoked = true
      return undefined
    }
    await expect(f.reader.readCurrent(f.input)).rejects.toThrow()
    expect(f.state.modelReads).toHaveLength(0)
  } finally {
    database.close()
  }
})
test('SQLite reopen retains both bindings and profile/model pins without adopting changed source defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-lead-product-'))
  let database = new DatabaseSync(join(directory, 'source.sqlite'))
  try {
    const first = fixture(database)
    const accepted = await first.reader.readCurrent(first.input)
    database.close()
    database = new DatabaseSync(join(directory, 'source.sqlite'))
    const reopened = fixture(database)
    expect(await reopened.reader.readCurrent(reopened.input)).toEqual(accepted)
    expect(reopened.state.defaults).toBe(0)
    expect(reopened.reader.readRetained(reopened.input).authority).toEqual(first.authority)
    reopened.state.snapshot.authority.host.enlistmentRevision++
    await expect(reopened.reader.readCurrent(reopened.input)).rejects.toThrow()
    expect(reopened.reader.readRetained(reopened.input).authority).toEqual(first.authority)
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProductionLeadProductAuthority } from './production-lead-product.ts'
import { createProductionLeadReadiness } from './production-lead-readiness.ts'

const suffix = '01JABCDEF0123456789ABCDEFG'
const actor = `user:${randomUUID()}`
const input = {
  schemaVersion: 'pi-lead-intent/v1',
  workspaceId: `wsp_${suffix}`,
  intentId: randomUUID(),
  principalId: 'svc_agent-hq',
}
const evidence = {
  ...input,
  messageRef: 'message:fixture',
  authorityRevision: 1,
  principalRef: actor,
  canonicalActorPrincipalId: actor,
  scopeRef: 'scope:fixture',
  expiresAt: '2026-10-09T00:00:00.000Z',
  allowedPrincipalIds: [input.principalId],
  prompt: 'Synthetic product test',
  profileId: 'profile:stored',
  profileVersion: '1.0.0',
  profileRevision: 0,
}
delete evidence.principalId
const profile = {
  profileId: evidence.profileId,
  profileVersion: evidence.profileVersion,
  profileRevision: 0,
  profileVersionId: `pfv_${suffix}`,
  profileContentDigest: `sha256:${'a'.repeat(64)}`,
}
const selection = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
function make(database) {
  const state = {
    product: structuredClone(evidence),
    profile: structuredClone(profile),
    selects: 0,
    revoked: false,
  }
  const ports = {
    database,
    target,
    now: () => '2026-10-08T00:00:00.000Z',
    product: { readCurrent: async () => state.product },
    profiles: { resolveImmutable: async () => state.profile },
    selections: {
      select: async () => {
        state.selects++
        return selection
      },
      resolveSelection: async (pin) => {
        expect(pin.selectionRef).toBe(selection.selectionRef)
        return selection
      },
      assertReady: async () => {
        if (state.revoked) throw new Error('CREDENTIAL_REVOKED')
      },
    },
  }
  return { state, authority: createProductionLeadProductAuthority(ports) }
}
test('actual SQLite restart retains the same selection winner without resolving changed defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-production-selection-'))
  let database = new DatabaseSync(join(directory, 'pins.sqlite'))
  try {
    const first = make(database)
    const accepted = await first.authority.readCurrent(input)
    expect(accepted.selectionRef).toBe(selection.selectionRef)
    expect(accepted.profileContentDigest).toBe(profile.profileContentDigest)
    expect(accepted.canonicalActorPrincipalId).toBe(actor)
    database.close()
    database = new DatabaseSync(join(directory, 'pins.sqlite'))
    const reopened = make(database)
    expect(await reopened.authority.readCurrent(input)).toEqual(accepted)
    expect(reopened.state.selects).toBe(0)
    reopened.state.revoked = true
    await expect(reopened.authority.readCurrent(input)).rejects.toThrow('CREDENTIAL_REVOKED')
    reopened.state.revoked = false
    reopened.state.product = undefined
    expect(await reopened.authority.readCurrent(input)).toBeUndefined()
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test('missing or changed profile and original actor cannot replace an accepted winner', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const { state, authority } = make(database)
    await authority.readCurrent(input)
    state.product.canonicalActorPrincipalId = `user:${randomUUID()}`
    await expect(authority.readCurrent(input)).rejects.toThrow('PI_PRODUCTION_PRODUCT_CHANGED')
    state.product = structuredClone(evidence)
    state.profile.profileContentDigest = `sha256:${'b'.repeat(64)}`
    await expect(authority.readCurrent(input)).rejects.toThrow('PI_PRODUCTION_PRODUCT_CHANGED')
    state.profile = undefined
    await expect(authority.readCurrent(input)).rejects.toThrow('PI_PRODUCTION_PROFILE_UNAVAILABLE')
    expect(state.selects).toBe(1)
  } finally {
    database.close()
  }
})
test('readiness rejects missing, malformed or mismatched original actors before forwarding', async () => {
  let calls = 0
  const ready = createProductionLeadReadiness(async () => {
    calls++
  })
  for (const [acceptedActor, requestedActor] of [
    [undefined, actor],
    ['svc_agent-hq', 'svc_agent-hq'],
    [actor, `user:${randomUUID()}`],
  ])
    await expect(
      ready({
        evidence: { canonicalActorPrincipalId: acceptedActor },
        actorPrincipalId: requestedActor,
      })
    ).rejects.toThrow()
  expect(calls).toBe(0)
  await ready({ evidence: { canonicalActorPrincipalId: actor }, actorPrincipalId: actor })
  expect(calls).toBe(1)
})

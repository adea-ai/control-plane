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
  return { state, ports, authority: createProductionLeadProductAuthority(ports) }
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

const fullSelection = (ref, model = 'gpt-5') => ({
  schemaVersion: 'model-selection/v1',
  selectionRef: ref,
  selectionRevision: 1,
  workspaceId: input.workspaceId,
  connectionRef: `mconn_${'1'.repeat(32)}`,
  connectionRevision: 1,
  credentialRef: `crd_${suffix}`,
  credentialRevision: 1,
  provider: 'openai',
  providerModel: model,
  accountRef: 'account:explicit',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  ...target,
  workspaceGrant: { grantRef: 'grant:explicit', revision: 1 },
  configurationRevision: 1,
})
const childRef = `msel_${'b'.repeat(32)}`
test('explicit lead and child refs stay distinct, survive reopen, and never select workspace defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-explicit-roles-'))
  let database = new DatabaseSync(join(directory, 'roles.sqlite'))
  const setup = () => {
    const fixture = make(database)
    fixture.state.product.requestedModelSelections = {
      lead: selection,
      child: { selectionRef: childRef, selectionRevision: 1 },
    }
    fixture.ports.selections.resolveSelection = async (pin) => fullSelection(pin.selectionRef)
    return { ...fixture, authority: createProductionLeadProductAuthority(fixture.ports) }
  }
  const child = {
    childRequestId: 'child:one',
    childRequestDigest: `sha256:${'c'.repeat(64)}`,
    canonicalActorPrincipalId: actor,
  }
  try {
    const first = setup()
    const accepted = await first.authority.readCurrent(input)
    expect(accepted.selectionRef).toBe(selection.selectionRef)
    expect(accepted.requestedModelSelections).toBeUndefined()
    expect((await first.authority.resolveChildSelection(input, child)).selectionRef).toBe(childRef)
    expect(first.state.selects).toBe(0)
    database.close()
    database = new DatabaseSync(join(directory, 'roles.sqlite'))
    const reopened = setup()
    expect(await reopened.authority.readCurrent(input)).toEqual(accepted)
    expect((await reopened.authority.resolveChildSelection(input, child)).selectionRef).toBe(
      childRef
    )
    expect(reopened.state.selects).toBe(0)
    reopened.state.product.requestedModelSelections.lead = {
      selectionRef: `msel_${'d'.repeat(32)}`,
      selectionRevision: 1,
    }
    await expect(reopened.authority.readCurrent(input)).rejects.toThrow(
      'PI_PRODUCTION_PRODUCT_CHANGED'
    )
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test('wrong workspace, target, revision and revoked explicit selections deny without fallback', async () => {
  for (const fault of ['workspace', 'target', 'revision', 'revoked']) {
    const database = new DatabaseSync(':memory:')
    try {
      const fixture = make(database)
      fixture.state.product.requestedModelSelections = { lead: selection }
      fixture.ports.selections.resolveSelection = async (pin) => {
        const value = fullSelection(pin.selectionRef)
        if (fault === 'workspace') value.workspaceId = `wsp_01JBBCDEF0123456789ABCDEFG`
        if (fault === 'target') value.location = 'local_device'
        if (fault === 'revision') value.selectionRevision = 2
        return value
      }
      fixture.state.revoked = fault === 'revoked'
      const authority = createProductionLeadProductAuthority(fixture.ports)
      await expect(authority.readCurrent(input)).rejects.toThrow()
      expect(fixture.state.selects).toBe(0)
      expect(
        database.prepare('SELECT COUNT(*) AS n FROM pi_production_lead_selections').get().n
      ).toBe(0)
    } finally {
      database.close()
    }
  }
})
test('child override is immutable per canonical request; child default never inherits lead', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const fixture = make(database)
    const roles = []
    fixture.ports.selections.select = async (request) => {
      roles.push(request.role)
      return fullSelection(request.role === 'lead' ? selection.selectionRef : childRef)
    }
    fixture.ports.selections.resolveSelection = async (pin) => fullSelection(pin.selectionRef)
    const authority = createProductionLeadProductAuthority(fixture.ports)
    await authority.readCurrent(input)
    const child = {
      childRequestId: 'child:one',
      childRequestDigest: `sha256:${'c'.repeat(64)}`,
      canonicalActorPrincipalId: actor,
    }
    expect((await authority.resolveChildSelection(input, child)).selectionRef).toBe(childRef)
    expect(roles).toEqual(['lead', 'child'])
    await expect(
      authority.resolveChildSelection(input, { ...child, requestedSelection: selection })
    ).rejects.toThrow('PI_ROLE_SELECTION_CHANGED')
    await expect(
      authority.resolveChildSelection(input, {
        ...child,
        canonicalActorPrincipalId: `user:${randomUUID()}`,
      })
    ).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
  } finally {
    database.close()
  }
})

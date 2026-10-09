import { expect, test } from 'bun:test'
import { CredentialApiFixtures } from '@control-plane/contracts'
import {
  ModelSelectionService,
  InMemoryModelSelectionRepository,
} from '@control-plane/model-gateway'
import { ConfiguredModelConnectionService } from './model-connections.service.ts'
import { connection } from './model-selection-fixtures.mjs'
import { createSelectedModelHostBridge } from './selected-model-host-bridge.fixture.mjs'

const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const intentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
async function fixture() {
  const repository = new InMemoryModelSelectionRepository()
  await repository.saveConnection(0, { ...connection, models: ['gpt-5', 'gpt-5-mini'] })
  const selections = new ModelSelectionService({
    repository,
    vault: {
      metadata: async () => ({
        credentialId: connection.credentialRef,
        workspaceId: connection.workspaceId,
        provider: connection.provider,
        revision: 1,
        status: 'active',
      }),
    },
    qualification: { evaluate: async () => 'READY' },
    now: () => '2026-10-08T12:00:00.000Z',
  })
  const api = new ConfiguredModelConnectionService(selections)
  const select = async (providerModel) =>
    (
      await api.resolve(
        {
          ...CredentialApiFixtures.get.request,
          caller: { servicePrincipalId: 'svc_workspace-admin' },
          workspaceId: connection.workspaceId,
          operation: 'model-selection.resolve',
          parameters: {
            role: 'lead',
            target,
            override: { connectionRef: connection.connectionRef, providerModel },
          },
        },
        'svc_workspace-admin'
      )
    ).data.selection
  return {
    repository,
    selections,
    select,
    bridge: createSelectedModelHostBridge({ selections, target }),
  }
}
const reference = (selection) => ({
  workspaceId: selection.workspaceId,
  intentId,
  selectionRef: selection.selectionRef,
  selectionRevision: selection.selectionRevision,
})

test('actual model metadata operation selection binds immutable intent instead of fixed synthetic ref', async () => {
  const { bridge, select } = await fixture()
  const chosen = await select('gpt-5-mini')
  expect(await bridge.bindIntent(reference(chosen))).toEqual(chosen)
  const facade = bridge.forIntent(reference(chosen))
  expect(await facade.resolveSelection(chosen)).toEqual(chosen)
  await facade.assertReady(chosen)
  const result = await bridge.bindIntent(reference(chosen))
  result.providerModel = 'changed-client-copy'
  expect((await bridge.resolveIntent(reference(chosen))).providerModel).toBe('gpt-5-mini')
  const different = await select('gpt-5')
  await expect(bridge.bindIntent(reference(different))).rejects.toMatchObject({
    code: 'SELECTION_CHANGED',
  })
  expect(await bridge.resolveIntent(reference(chosen))).toEqual(chosen)
})

test('unknown, wrong workspace, snapshot injection and mismatched target cannot bind', async () => {
  const { bridge, select, selections } = await fixture()
  const chosen = await select('gpt-5')
  await expect(
    bridge.bindIntent({ ...reference(chosen), selectionRef: `msel_${'f'.repeat(32)}` })
  ).rejects.toMatchObject({ code: 'SELECTION_CHANGED' })
  await expect(
    bridge.bindIntent({
      ...reference(chosen),
      workspaceId: `${connection.workspaceId.slice(0, -1)}H`,
    })
  ).rejects.toMatchObject({ code: 'SELECTION_CHANGED' })
  await expect(
    bridge.bindIntent({ ...reference(chosen), providerModel: 'client-snapshot' })
  ).rejects.toThrow()
  const incompatible = createSelectedModelHostBridge({
    selections,
    target: { ...target, harnessVersion: '1.1.1' },
  })
  await expect(incompatible.bindIntent(reference(chosen))).rejects.toMatchObject({
    code: 'SELECTION_CHANGED',
  })
})

test('connection revocation denies previously accepted selection without credential use', async () => {
  const { bridge, select, repository } = await fixture()
  const chosen = await select('gpt-5')
  await bridge.bindIntent(reference(chosen))
  await repository.saveConnection(1, {
    ...connection,
    models: ['gpt-5', 'gpt-5-mini'],
    revision: 2,
    status: 'revoked',
  })
  await expect(bridge.resolveIntent(reference(chosen))).rejects.toMatchObject({
    code: 'CONNECTION_REVOKED',
  })
})

test('same-intent racing different selections produce one immutable winner', async () => {
  const { bridge, select } = await fixture()
  const choices = await Promise.all([select('gpt-5'), select('gpt-5-mini')])
  const results = await Promise.allSettled(
    choices.map((choice) => bridge.bindIntent(reference(choice)))
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  const winner = results.find((result) => result.status === 'fulfilled').value
  expect(await bridge.resolveIntent(reference(winner))).toEqual(winner)
})

test('credential callback delegates accepted store snapshot and rechecks readiness inside callback', async () => {
  const { selections, select } = await fixture()
  const chosen = await select('gpt-5-mini')
  let uses = 0
  let revoked = false
  let revokeInside = false
  let operations = 0
  const port = {
    resolveSelection: (query) => selections.resolveSelection(query),
    assertReady: async (candidate) => {
      if (revoked) throw new Error('TEST_CURRENT_DENIAL')
      await selections.assertReady(candidate)
    },
    withCredential: async (candidate, authority, callback) => {
      expect(candidate).toEqual(chosen)
      expect(authority.principalRef).toBe('svc_separate-lease')
      uses++
      await Promise.resolve()
      if (revokeInside) revoked = true
      return callback('synthetic-test-only')
    },
  }
  const bridge = createSelectedModelHostBridge({ selections: port, target })
  await bridge.bindIntent(reference(chosen))
  const facade = bridge.forIntent(reference(chosen))
  const operation = async () => {
    operations++
    return { completed: true }
  }
  expect(
    await facade.withCredential(chosen, { principalRef: 'svc_separate-lease' }, operation)
  ).toEqual({ completed: true })
  revokeInside = true
  await expect(
    facade.withCredential(chosen, { principalRef: 'svc_separate-lease' }, operation)
  ).rejects.toThrow('TEST_CURRENT_DENIAL')
  expect(uses).toBe(2)
  expect(operations).toBe(1)
  await expect(facade.withCredential(chosen, {}, operation)).rejects.toThrow('TEST_CURRENT_DENIAL')
  expect(uses).toBe(2)
  expect(operations).toBe(1)
})

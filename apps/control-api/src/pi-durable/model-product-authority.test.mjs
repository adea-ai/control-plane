import { expect, test } from 'bun:test'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import { createCanonicalModelExecutionAuthority } from '../models/canonical-model-host.ts'
import { createPiLeadModelProductAuthority } from './model-product-authority.ts'

async function setup(workspace = true) {
  const f = await fixture()
  const {
    executionId: _execution,
    attemptId: _attempt,
    executionScope: _scope,
    ...metadata
  } = f.intent
  let evidence = {
    ...metadata,
    schemaVersion: 'pi-lead-intent/v1',
    projectId: null,
    prompt: 'Authorized product message',
    profileVersionId: f.plan.profile.profileVersionId,
    profileContentDigest: f.plan.profile.contentDigest,
  }
  const product = createPiLeadModelProductAuthority({
    product: { readCurrent: async () => structuredClone(evidence) },
    ...(workspace ? { workspaceScope: { assertSupported: async () => {} } } : {}),
  })
  const host = createCanonicalModelExecutionAuthority({ ...f.hostOptions, product })
  return {
    ...f,
    host,
    product,
    setEvidence: (change) => {
      evidence = { ...evidence, ...change }
    },
  }
}

test('fresh parsed null-project evidence becomes explicit workspace metadata for the unchanged canonical host', async () => {
  const f = await setup()
  const binding = await f.host.resolveForReader(f.reader)
  expect(binding.canonicalActorPrincipalId).toBe(f.intent.canonicalActorPrincipalId)
  const metadata = await f.product.readCurrent({
    schemaVersion: 'pi-lead-intent/v1',
    intentId: f.intent.intentId,
    workspaceId: f.intent.workspaceId,
    principalId: f.reader.principalId,
  })
  expect(metadata.executionScope).toEqual({ schemaVersion: 1, kind: 'workspace' })
  for (const field of ['projectId', 'prompt', 'profileVersionId', 'profileContentDigest'])
    expect(metadata).not.toHaveProperty(field)
  f.setEvidence({ projectId: undefined })
  expect(await f.host.resolveForReader(f.reader)).toEqual(binding)
})

test('workspace normalization requires host opt-in and an original canonical actor', async () => {
  const absent = await setup(false)
  await expect(absent.host.resolveForReader(absent.reader)).rejects.toThrow(
    'PROVIDER_POLICY_DENIED'
  )
  const actor = await setup()
  actor.setEvidence({ canonicalActorPrincipalId: undefined })
  await expect(actor.host.resolveForReader(actor.reader)).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

test('fresh product project, actor, expiry and unsupported runtime changes still deny canonical binding', async () => {
  for (const change of [
    { projectId: 'prj_01JABCDEF0123456789ABCDEFG' },
    { projectId: 'prj_01JBBCDEF0123456789ABCDEFG' },
    { canonicalActorPrincipalId: 'actor:changed' },
    { expiresAt: '2026-10-08T11:00:00.000Z' },
  ]) {
    const f = await setup()
    f.setEvidence(change)
    await expect(f.host.resolveForReader(f.reader)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  }
  const f = await setup()
  const product = createPiLeadModelProductAuthority({
    product: {
      readCurrent: async (input) => {
        const current = await f.product.readCurrent(input)
        const { executionScope: _scope, ...metadata } = current
        return {
          ...metadata,
          projectId: null,
          prompt: 'message',
          profileVersionId: f.plan.profile.profileVersionId,
          profileContentDigest: f.plan.profile.contentDigest,
        }
      },
    },
    workspaceScope: {
      assertSupported: async () => {
        throw new Error('UNSUPPORTED_RUNTIME')
      },
    },
  })
  await expect(
    createCanonicalModelExecutionAuthority({ ...f.hostOptions, product }).resolveForReader(f.reader)
  ).rejects.toThrow('PROVIDER_POLICY_DENIED')
})

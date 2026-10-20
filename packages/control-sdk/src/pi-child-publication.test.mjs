import { expect, test } from 'bun:test'
import { PublicContractFixtures } from '@control-plane/contracts'
import { ControlPlaneClient, ControlApiOperations } from './index.ts'

test('child publication SDK sends only exact identifiers and rejects caller content', async () => {
  const { projectId: _, ...read } = PublicContractFixtures.request
  const suffix = '01JABCDEF0123456789ABCDEFG'
  const parameters = {
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    preparationRef: `prep_${'b'.repeat(32)}`,
    delegationId: `dlg_${suffix}`,
  }
  const publication = {
    schemaVersion: 'pi-child-publication/v1',
    workspaceId: read.workspaceId,
    intentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
    dispatchId: parameters.dispatchId,
    executionId: `exe_${suffix}`,
    attemptId: `att_${suffix}`,
    runtimeSessionId: `ses_${suffix}`,
    canonicalActorPrincipalId: 'user:f643a115-617d-4bae-8d52-cfe458c0b8ac',
    delegationId: parameters.delegationId,
    childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
    childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    role: 'researcher',
    state: 'completed',
    resultRef: `art_${suffix}`,
    conclusion: 'The bounded question is resolved.',
    occurredAt: '2026-10-08T00:00:01.000Z',
    authorityRevision: 1,
    expiresAt: '2026-10-08T00:00:20.000Z',
  }
  let calls = 0
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'synthetic-service-credential',
    fetch: async (url, init) => {
      calls++
      expect(String(url)).toBe(
        'https://control-plane.example/v1/pi-durable/child-publication/current'
      )
      expect(JSON.parse(init.body).parameters).toEqual(parameters)
      return new Response(
        JSON.stringify({
          contractVersion: read.contractVersion,
          requestId: read.requestId,
          correlation: read.correlation,
          data: { publication },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
  })
  const request = { ...read, operation: 'pi-durable.child.publication.current', parameters }
  expect((await client.getPiDurableChildPublication(request)).data.publication).toEqual(publication)
  expect(calls).toBe(1)
  expect(
    ControlApiOperations.getPiDurableChildPublication.requestSchema.safeParse({
      ...request,
      parameters: { ...parameters, content: 'forged' },
    }).success
  ).toBe(false)
})

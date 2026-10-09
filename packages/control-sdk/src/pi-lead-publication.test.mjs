import { expect, test } from 'bun:test'
import { PublicContractFixtures } from '@control-plane/contracts'
import { ControlPlaneClient, ControlApiOperations } from './index.ts'

test('publication SDK sends only references and validates exact current publication projection', async () => {
  const { projectId: _, ...read } = PublicContractFixtures.request
  const parameters = {
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    preparationRef: `prep_${'b'.repeat(32)}`,
  }
  const publication = {
    schemaVersion: 'pi-lead-publication/v1',
    workspaceId: read.workspaceId,
    intentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
    ...parameters,
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    runtimeSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 1,
    canonicalActorPrincipalId: 'user:f643a115-617d-4bae-8d52-cfe458c0b8ac',
    authorityRevision: 1,
    resultContentDigest: `sha256:${'d'.repeat(64)}`,
    expiresAt: '2026-10-08T22:00:00.000Z',
  }
  let calls = 0
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'synthetic-service-credential',
    fetch: async (url, init) => {
      calls++
      expect(String(url)).toBe(
        'https://control-plane.example/v1/pi-durable/lead-publication/current'
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
  const request = { ...read, operation: 'pi-durable.lead.publication.current', parameters }
  expect((await client.getPiDurableLeadPublication(request)).data.publication).toEqual(publication)
  expect(calls).toBe(1)
  expect(
    ControlApiOperations.getPiDurableLeadPublication.requestSchema.safeParse({
      ...request,
      parameters: { ...parameters, output: 'caller output' },
    }).success
  ).toBe(false)
})

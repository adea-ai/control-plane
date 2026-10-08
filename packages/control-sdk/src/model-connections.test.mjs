import { expect, test } from 'bun:test'
import { CredentialApiFixtures, ControlApiOperations, ControlPlaneClient } from './index.ts'

test('released model SDK operations send scoped references and reject credential-bearing payloads before transport', async () => {
  const cases = [
    [
      'getModelSelectionFunding',
      false,
      {
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        selectionRef: `msel_${'2'.repeat(32)}`,
        selectionRevision: 1,
      },
    ],
    [
      'createModelConnection',
      true,
      { credentialRef: 'crd_01JABCDEF0123456789ABCDEFG', credentialRevision: 1 },
    ],
    [
      'revokeModelConnection',
      true,
      { connectionRef: `mconn_${'1'.repeat(32)}`, expectedRevision: 1 },
    ],
    [
      'listModelConnections',
      false,
      {
        target: {
          location: 'remote_host',
          harness: 'pi_durable',
          harnessVersion: '1.1.0',
          providerBinding: 'pi_durable_models',
        },
      },
    ],
    ['getModelDefaults', false, {}],
    ['setModelDefaults', true, { expectedRevision: 0 }],
    [
      'resolveModelSelection',
      false,
      {
        role: 'direct',
        target: {
          location: 'remote_host',
          harness: 'pi_durable',
          harnessVersion: '1.1.0',
          providerBinding: 'pi_durable_models',
        },
        override: { connectionRef: `mconn_${'1'.repeat(32)}`, providerModel: 'fixture-model' },
      },
    ],
  ]
  for (const [name, command, data] of cases) {
    const operation = ControlApiOperations[name]
    const input = {
      ...(command ? CredentialApiFixtures.rotate.request : CredentialApiFixtures.get.request),
      caller: { servicePrincipalId: 'svc_workspace-admin' },
      operation: operation.operation,
      ...(command ? { payload: data } : { parameters: data }),
    }
    let sends = 0
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'sdk-test-service-token',
      fetch: async (url, init) => {
        sends++
        expect(String(url)).toBe(`https://control-plane.test${operation.path}`)
        expect(JSON.parse(init.body)).toEqual(input)
        // A bounded setup failure proves the real typed method reached its exact route.
        return Response.json(
          {
            contractVersion: input.contractVersion,
            requestId: input.requestId,
            correlation: input.correlation,
            error: {
              code: 'READINESS_UNAVAILABLE',
              message: 'Model readiness unavailable',
              class: 'runtime_unavailable',
              retryable: true,
              source: 'provider',
            },
          },
          { status: 503 }
        )
      },
    })
    await expect(client[name](input)).rejects.toMatchObject({ code: 'READINESS_UNAVAILABLE' })
    expect(sends).toBe(1)
    const secretInput = {
      ...input,
      [command ? 'payload' : 'parameters']: { ...data, secret: 'credential-canary-not-sent' },
    }
    await expect(client[name](secretInput)).rejects.toThrow()
    expect(sends).toBe(1)
  }
})

test('typed funding read parses bounded ready/blocked views and rejects response secrets', async () => {
  const operation = ControlApiOperations.getModelSelectionFunding
  const parameters = {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    selectionRef: `msel_${'2'.repeat(32)}`,
    selectionRevision: 1,
  }
  const input = {
    ...CredentialApiFixtures.get.request,
    caller: { servicePrincipalId: 'svc_workspace-admin' },
    operation: operation.operation,
    parameters,
  }
  const binding = {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: input.workspaceId,
    ...parameters,
  }
  let funding = {
    ...binding,
    state: 'ready',
    provider: 'openai',
    providerModel: 'fixture',
    accountRef: 'account:one',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    fundingOwner: {
      ownerRef: 'payer:explicit',
      kind: 'workspace_account',
      displayName: 'Fixture payer',
      revision: 1,
      evidenceRef: 'payer-proof:1',
    },
    authorizationRef: 'auth:one',
    authorityRevision: 1,
    expiresAt: '2026-10-08T13:00:00.000Z',
  }
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.test',
    credential: 'fixture',
    fetch: async () =>
      Response.json({
        contractVersion: input.contractVersion,
        requestId: input.requestId,
        correlation: input.correlation,
        data: { funding },
      }),
  })
  expect((await client.getModelSelectionFunding(input)).data.funding.fundingOwner.ownerRef).toBe(
    'payer:explicit'
  )
  funding = { ...binding, state: 'blocked', reasonCode: 'CREDENTIAL_REVOKED' }
  expect((await client.getModelSelectionFunding(input)).data.funding.reasonCode).toBe(
    'CREDENTIAL_REVOKED'
  )
  funding = { ...funding, secret: 'private-canary' }
  await expect(client.getModelSelectionFunding(input)).rejects.toThrow()
})

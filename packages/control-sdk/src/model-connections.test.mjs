import { expect, test } from 'bun:test'
import { CredentialApiFixtures, ControlApiOperations, ControlPlaneClient } from './index.ts'

test('released model SDK operations send scoped references and reject credential-bearing payloads before transport', async () => {
  const cases = [
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

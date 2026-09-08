import { afterEach, describe, expect, test } from 'bun:test'
import { ControlApiFixtures, ControlPlaneClient, ControlPlaneClientError } from './index.ts'
import { createControlPlaneStub } from './testing.ts'

const stubs = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

describe('deterministic Control Plane stub', () => {
  test('supports the public execution cancellation command', async () => {
    const stub = await createControlPlaneStub()
    stubs.push(stub)
    const client = new ControlPlaneClient({ baseUrl: stub.url, credential: 'stub-agent-hq-token' })
    const request = {
      ...ControlApiFixtures.executionAcceptance.request,
      operation: 'execution.cancel',
      payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
    }
    expect((await client.cancelExecution(request)).data).toMatchObject({
      commandId: request.commandId,
      executionId: request.payload.executionId,
      status: 'accepted',
    })
    expect(stub.requests.map(({ operation }) => operation)).toEqual(['execution.cancel'])
  })
  test('supports representative Agent HQ contract flows', async () => {
    const stub = await createControlPlaneStub()
    stubs.push(stub)
    const client = new ControlPlaneClient({
      baseUrl: stub.url,
      credential: 'stub-agent-hq-token',
    })

    expect(await client.verifyAuthentication(ControlApiFixtures.authentication.request)).toEqual(
      ControlApiFixtures.authentication.response
    )
    expect(await client.resolveProfile(ControlApiFixtures.profileResolution.request)).toEqual(
      ControlApiFixtures.profileResolution.response
    )
    expect(
      await client.resolveProjectState(ControlApiFixtures.projectStateResolution.request)
    ).toEqual(ControlApiFixtures.projectStateResolution.response)
    expect(
      await client.resolveContextPackage(ControlApiFixtures.contextPackageResolution.request)
    ).toEqual(ControlApiFixtures.contextPackageResolution.response)
    expect(await client.listRuntimes(ControlApiFixtures.runtimeList.request)).toEqual(
      ControlApiFixtures.runtimeList.response
    )
    expect(
      await client.validateExecutionRequest(ControlApiFixtures.executionValidation.request)
    ).toEqual(ControlApiFixtures.executionValidation.response)
    expect(await client.acceptExecution(ControlApiFixtures.executionAcceptance.request)).toEqual(
      ControlApiFixtures.executionAcceptance.response
    )
    expect(
      await client.respondToInteraction(ControlApiFixtures.interactionResponse.request)
    ).toEqual(ControlApiFixtures.interactionResponse.response)

    expect(stub.requests.map((request) => request.operation)).toEqual([
      'authentication.verify',
      'profile.resolve',
      'project-state.resolve',
      'context-package.resolve',
      'runtime.list',
      'execution.validate',
      'execution.accept',
      'interaction.respond',
    ])
    expect(JSON.stringify(stub.requests)).not.toContain('stub-agent-hq-token')
  })

  test('returns deterministic authentication and validation failures', async () => {
    const stub = await createControlPlaneStub()
    stubs.push(stub)
    const unauthorizedClient = new ControlPlaneClient({
      baseUrl: stub.url,
      credential: 'wrong-token',
    })

    await expect(
      unauthorizedClient.verifyAuthentication(ControlApiFixtures.authentication.request)
    ).rejects.toEqual(
      new ControlPlaneClientError({
        code: 'SERVICE_CREDENTIAL_REJECTED',
        errorClass: 'authentication',
        message: 'Service credential is not accepted',
        requestId: 'req_01JABCDEF0123456789ABCDEFG',
        retryable: false,
        status: 401,
      })
    )

    const response = await globalThis.fetch(`${stub.url}/v1/executions/validate`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer stub-agent-hq-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ invalid: true }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { class: 'validation', code: 'INVALID_REQUEST', retryable: false },
    })
  })
})

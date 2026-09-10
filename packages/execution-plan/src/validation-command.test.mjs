import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { executionValidationPayloadHash, executionValidationCommandKey } from './index.ts'

test('validation identity hashes the parsed semantic payload independently of retry metadata', () => {
  const request = ControlApiFixtures.executionValidation.request
  const expected = executionValidationPayloadHash(request)
  expect(
    executionValidationPayloadHash({
      ...request,
      issuedAt: '2026-09-07T12:00:00.000Z',
      payloadHash: '0'.repeat(64),
      payload: Object.fromEntries(Object.entries(request.payload).toReversed()),
    })
  ).toBe(expected)
  for (const payload of [
    { ...request.payload, outputContractRef: 'contract://other/v1' },
    { ...request.payload, runtimeRequirements: ['model.select'] },
    { ...request.payload, projectState: { ...request.payload.projectState, revision: 999 } },
    {
      ...request.payload,
      contextPackage: {
        ...request.payload.contextPackage,
        contentDigest: `sha256:${'0'.repeat(64)}`,
      },
    },
  ])
    expect(executionValidationPayloadHash({ ...request, payload })).not.toBe(expected)
  const scope = {
    callerPrincipalId: request.caller.servicePrincipalId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
  }
  expect(executionValidationCommandKey(scope)).toMatch(/^[a-f0-9]{64}$/)
  expect(executionValidationCommandKey({ ...scope, callerPrincipalId: 'svc_other' })).not.toBe(
    executionValidationCommandKey(scope)
  )
  expect(() => executionValidationCommandKey({ ...scope, operation: 'execution.accept' })).toThrow()
})

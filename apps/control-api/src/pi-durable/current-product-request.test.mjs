import { expect, test } from 'bun:test'
import { currentProductHttpRequest } from './current-product-request.fixture.mjs'

const request = {
  schemaVersion: 'pi-lead-intent/v1',
  workspaceId: 'workspace-fixture',
  intentId: 'intent-fixture',
  principalId: 'transport-fixture',
}

test('versioned internal product request serializes to exactly the agreed HTTP identifiers', () => {
  const serialized = JSON.parse(JSON.stringify(currentProductHttpRequest(request)))
  expect(Object.keys(serialized).toSorted()).toEqual(['intentId', 'principalId', 'workspaceId'])
  expect(serialized).toEqual({
    workspaceId: request.workspaceId,
    intentId: request.intentId,
    principalId: request.principalId,
  })
  expect(request.schemaVersion).toBe('pi-lead-intent/v1')
})

test('wrong internal version, missing identifiers and extra authority fields fail closed', () => {
  for (const input of [
    { ...request, schemaVersion: 'pi-lead-intent/v2' },
    { ...request, principalId: '' },
    { ...request, workspaceId: undefined },
    { ...request, actorPrincipalId: 'caller-supplied-actor' },
    { ...request, selectionRef: 'caller-supplied-selection' },
  ])
    expect(() => currentProductHttpRequest(input)).toThrow(
      'CANDIDATE_PRODUCT_READER_REQUEST_INVALID'
    )
})

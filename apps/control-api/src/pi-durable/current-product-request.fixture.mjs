// TEST ONLY. The internal versioned authority port is not the HTTP identifier protocol.
export function currentProductHttpRequest(input) {
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).toSorted().join(',') !== 'intentId,principalId,schemaVersion,workspaceId' ||
    input.schemaVersion !== 'pi-lead-intent/v1' ||
    ['workspaceId', 'intentId', 'principalId'].some(
      (key) => typeof input[key] !== 'string' || !input[key] || input[key].length > 256
    )
  )
    throw new Error('CANDIDATE_PRODUCT_READER_REQUEST_INVALID')
  return {
    workspaceId: input.workspaceId,
    intentId: input.intentId,
    principalId: input.principalId,
  }
}

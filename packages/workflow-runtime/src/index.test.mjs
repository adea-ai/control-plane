import { describe, expect, test } from 'bun:test'
import { createRestateEndpointOptions, restateWorkflowName, workflowPolicies } from './index.ts'

describe('portable workflow runtime', () => {
  test('keeps the accepted lifecycle identity across deployment profiles', () => {
    const options = createRestateEndpointOptions()

    expect(restateWorkflowName).toBe('execution-lifecycle')
    expect(workflowPolicies.version).toBe('execution-lifecycle-v1')
    expect(options.bidirectional).toBe(false)
    expect(options.services).toHaveLength(1)
  })
  test('allows explicit direct-connection streaming without changing the portable default', () => {
    expect(createRestateEndpointOptions({ bidirectional: true }).bidirectional).toBe(true)
    expect(createRestateEndpointOptions().bidirectional).toBe(false)
  })
})

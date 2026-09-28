import { describe, expect, test } from 'bun:test'
import {
  RETIRED_COMMAND_KEY_METADATA_VERSION,
  retiredCommandKeyCandidates,
  retiredCommandKeyFromMetadataV2,
  retiredCommandKeyMetadataV2,
  retiredCommandKeyV1,
  retiredCommandScopeV1,
} from './index.js'

const scope = {
  callerPrincipalId: 'svc_retention-test',
  operation: 'execution.accept',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  idempotencyKey: 'retired-command-key-test-1',
}

describe('retired command key metadata', () => {
  test('retains exact v1 lookup while deriving a fixed-size versioned v2 proof', () => {
    const legacyScope = retiredCommandScopeV1(scope)
    const metadata = retiredCommandKeyMetadataV2(scope)

    expect(legacyScope).toBe(
      [
        scope.callerPrincipalId,
        scope.operation,
        scope.workspaceId,
        scope.projectId,
        scope.idempotencyKey,
      ].join('\u001f')
    )
    expect(retiredCommandKeyV1(scope)).toMatch(/^[a-f0-9]{64}$/)
    expect(metadata).toEqual({
      metadataVersion: RETIRED_COMMAND_KEY_METADATA_VERSION,
      identityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(retiredCommandKeyFromMetadataV2(metadata.identityDigest)).toBe(metadata.scopeKey)
    expect(JSON.stringify(metadata)).not.toContain(scope.idempotencyKey)
    expect(retiredCommandKeyCandidates(scope)).toMatchObject({
      legacyScope,
      legacyKey: retiredCommandKeyV1(scope),
      metadata,
    })
  })

  test('binds every scope component and rejects invalid retained digests', () => {
    const alternatives = {
      callerPrincipalId: 'svc_retention-other',
      operation: 'execution.submit',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      idempotencyKey: 'retired-command-key-test-2',
    }
    for (const [key, value] of Object.entries(alternatives)) {
      expect(retiredCommandKeyMetadataV2({ ...scope, [key]: value }).scopeKey).not.toBe(
        retiredCommandKeyMetadataV2(scope).scopeKey
      )
    }
    expect(() => retiredCommandKeyFromMetadataV2('a'.repeat(63))).toThrow()
    expect(() => retiredCommandKeyFromMetadataV2('g'.repeat(64))).toThrow()
  })
})

import { describe, expect, test } from 'bun:test'
import { ToolCallSchema, ToolDefinitionSchema, ToolVersionSchema } from './index.ts'

const definition = {
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  name: 'files.read',
  displayName: 'Read file',
  description: 'Reads an explicitly scoped file.',
  ownership: { scope: 'workspace', workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG' },
  createdAt: '2026-08-25T08:00:00.000Z',
}

const version = {
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  toolDefinitionId: definition.toolDefinitionId,
  semanticVersion: '1.0.0',
  revision: 1,
  lifecycle: 'published',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', maxLength: 256 } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
    additionalProperties: false,
  },
  operations: [
    {
      name: 'read',
      requiredCapabilities: ['filesystem.read'],
      riskClass: 'low',
      approvalMode: 'never',
      idempotency: 'inherent',
    },
  ],
  executor: { type: 'internal', reference: 'files-v1' },
  limits: { maxInputBytes: 1024, maxOutputBytes: 4096, timeoutMs: 5_000 },
  createdAt: '2026-08-25T08:01:00.000Z',
  publishedAt: '2026-08-25T08:02:00.000Z',
}

describe('canonical tool contracts', () => {
  test('models a provider-neutral, version-pinned tool contract', () => {
    expect(ToolDefinitionSchema.parse(definition)).toEqual(definition)
    expect(ToolVersionSchema.parse(version)).toEqual(version)
    expect(['internal', 'connector', 'mcp', 'sandbox']).toContain(version.executor.type)
  })

  test('rejects credentials and malformed operation metadata', () => {
    expect(() => ToolDefinitionSchema.parse({ ...definition, credential: 'secret' })).toThrow()
    expect(() =>
      ToolVersionSchema.parse({
        ...version,
        executor: { ...version.executor, apiKey: 'secret' },
      })
    ).toThrow()
    expect(() =>
      ToolVersionSchema.parse({
        ...version,
        operations: [{ ...version.operations[0], requiredCapabilities: ['Filesystem.Read'] }],
      })
    ).toThrow()
  })

  test('preserves untagged tool-call digests and accepts only supported V2 tags', () => {
    const call = {
      toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      principalRef: 'service:runtime-worker',
      toolDefinitionId: definition.toolDefinitionId,
      toolVersionId: version.toolVersionId,
      operation: 'read',
      inputDigest: `sha256:${'b'.repeat(64)}`,
      policySnapshotRef: 'policy://workspace/v7',
      executor: { type: 'internal', reference: 'files-v1' },
      idempotencyKey: 'tool-read-0001',
      status: 'requested',
      revision: 1,
      requestedAt: '2026-08-25T09:00:00.000Z',
      history: [{ status: 'requested', at: '2026-08-25T09:00:00.000Z' }],
    }

    expect(ToolCallSchema.parse(call)).toEqual(call)
    expect(
      ToolCallSchema.parse({ ...call, requestDigestVersion: 2, inputDigestVersion: 2 })
    ).toMatchObject({ requestDigestVersion: 2, inputDigestVersion: 2 })

    for (const invalidVersion of [1, 3, '2', null]) {
      expect(
        ToolCallSchema.safeParse({ ...call, requestDigestVersion: invalidVersion }).success
      ).toBe(false)
      expect(
        ToolCallSchema.safeParse({ ...call, inputDigestVersion: invalidVersion }).success
      ).toBe(false)
    }
  })
})

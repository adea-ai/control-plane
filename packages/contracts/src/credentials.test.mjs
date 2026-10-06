import { describe, expect, test } from 'bun:test'
import {
  CredentialApiFixtures,
  CredentialCreateRequestSchema,
  CredentialGetRequestSchema,
  CredentialListRequestSchema,
  CredentialListResponseSchema,
  CredentialResponseSchema,
  CredentialRevokeRequestSchema,
  CredentialRotateRequestSchema,
  ReadRequestEnvelopeSchema,
  StateChangingCommandEnvelopeSchema,
} from './index.ts'

describe('credential Control API contracts', () => {
  test('fixtures parse and remain valid generic service envelopes', () => {
    const pairs = [
      [
        CredentialCreateRequestSchema,
        CredentialApiFixtures.create,
        StateChangingCommandEnvelopeSchema,
      ],
      [
        CredentialRotateRequestSchema,
        CredentialApiFixtures.rotate,
        StateChangingCommandEnvelopeSchema,
      ],
      [
        CredentialRevokeRequestSchema,
        CredentialApiFixtures.revoke,
        StateChangingCommandEnvelopeSchema,
      ],
      [CredentialGetRequestSchema, CredentialApiFixtures.get, ReadRequestEnvelopeSchema],
      [CredentialListRequestSchema, CredentialApiFixtures.list, ReadRequestEnvelopeSchema],
    ]
    for (const [schema, fixture, envelope] of pairs) {
      expect(schema.parse(fixture.request)).toEqual(fixture.request)
      expect(envelope.safeParse(fixture.request).success).toBe(true)
    }
    for (const fixture of [
      CredentialApiFixtures.create,
      CredentialApiFixtures.rotate,
      CredentialApiFixtures.revoke,
      CredentialApiFixtures.get,
    ]) {
      expect(CredentialResponseSchema.parse(fixture.response)).toEqual(fixture.response)
    }
    expect(CredentialListResponseSchema.parse(CredentialApiFixtures.list.response)).toEqual(
      CredentialApiFixtures.list.response
    )
  })

  test('responses cannot carry secret material or provider references', () => {
    const credential = CredentialApiFixtures.get.response.data.credential
    for (const extra of [
      { secret: 'leaked-secret-value' },
      { secretRevisions: [] },
      { locator: 'neon://credential-secrets/crd' },
      { ciphertextDigest: `sha256:${'a'.repeat(64)}` },
    ]) {
      expect(
        CredentialResponseSchema.safeParse({
          ...CredentialApiFixtures.get.response,
          data: { credential: { ...credential, ...extra } },
        }).success
      ).toBe(false)
    }
  })

  test('secrets are bounded, control-character free and accepted only on create or rotate', () => {
    const create = CredentialApiFixtures.create.request
    for (const secret of [
      'short',
      'x'.repeat(65_537),
      'line\nbreak-secret',
      'tab\tsecret-1',
      'del\u007fsecret-1',
    ]) {
      expect(
        CredentialCreateRequestSchema.safeParse({
          ...create,
          payload: { ...create.payload, secret },
        }).success
      ).toBe(false)
    }
    expect(
      CredentialRevokeRequestSchema.safeParse({
        ...CredentialApiFixtures.revoke.request,
        payload: { ...CredentialApiFixtures.revoke.request.payload, secret: 'x'.repeat(16) },
      }).success
    ).toBe(false)
    expect(
      CredentialGetRequestSchema.safeParse({
        ...CredentialApiFixtures.get.request,
        parameters: { ...CredentialApiFixtures.get.request.parameters, secret: 'x'.repeat(16) },
      }).success
    ).toBe(false)
  })

  test('workspace is the only authority scope', () => {
    for (const [schema, request] of [
      [CredentialCreateRequestSchema, CredentialApiFixtures.create.request],
      [CredentialListRequestSchema, CredentialApiFixtures.list.request],
    ]) {
      expect(
        schema.safeParse({ ...request, projectId: 'prj_01JABCDEF0123456789ABCDEFG' }).success
      ).toBe(false)
      expect(schema.safeParse({ ...request, workspaceId: undefined }).success).toBe(false)
    }
    expect(
      CredentialCreateRequestSchema.safeParse({
        ...CredentialApiFixtures.create.request,
        payload: {
          ...CredentialApiFixtures.create.request.payload,
          workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH',
        },
      }).success
    ).toBe(false)
  })
})

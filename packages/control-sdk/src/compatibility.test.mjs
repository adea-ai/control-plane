import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  assertBaselineUnchanged,
  createControlApiOpenApiDocument,
  findBreakingContractChanges,
} from '../scripts/openapi.mjs'

describe('Control API generated contract', () => {
  test('matches the committed OpenAPI artifact deterministically', async () => {
    const generated = createControlApiOpenApiDocument()
    const committed = JSON.parse(
      await readFile(new URL('../openapi/control-plane.v3.json', import.meta.url), 'utf8')
    )

    expect(generated).toEqual(committed)
    expect(Object.keys(generated.paths).sort()).toEqual([
      '/v1/authentication/verify',
      '/v1/context-packages/resolve',
      '/v1/executions/accept',
      '/v1/executions/cancel',
      '/v1/executions/validate',
      '/v1/external-sessions/get',
      '/v1/external-sessions/list',
      '/v1/interactions/respond',
      '/v1/marketplace/catalog',
      '/v1/marketplace/install',
      '/v1/marketplace/install-plan',
      '/v1/profiles/resolve',
      '/v1/project-states/resolve',
      '/v1/runtime-connections/get',
      '/v1/runtime-connections/list',
      '/v1/runtimes/list',
    ])
  })

  test('protects HTTP 202 acknowledgement schemas as well as HTTP 200 responses', () => {
    const baseline = createControlApiOpenApiDocument()
    const changed = structuredClone(baseline)
    delete changed.paths['/v1/interactions/respond'].post.responses['202']
    expect(findBreakingContractChanges(baseline, changed).length).toBeGreaterThan(0)
    const malformed = structuredClone(baseline)
    malformed.paths['/v1/interactions/respond'].post.responses['202'].content[
      'application/json'
    ].schema.properties.data.properties.status = { type: 'number' }
    expect(findBreakingContractChanges(baseline, malformed).length).toBeGreaterThan(0)
  })

  test('allows additive optional fields while rejecting breaking v2 changes', () => {
    const baseline = createControlApiOpenApiDocument()
    const additive = globalThis.structuredClone(baseline)
    additive.paths['/v1/profiles/resolve'].post.responses['200'].content[
      'application/json'
    ].schema.properties.data.properties.optionalFutureField = { type: 'string' }
    expect(findBreakingContractChanges(baseline, additive)).toEqual([])

    const removedOperation = globalThis.structuredClone(baseline)
    delete removedOperation.paths['/v1/profiles/resolve']
    expect(findBreakingContractChanges(baseline, removedOperation)).toContain(
      'Removed operation POST /v1/profiles/resolve'
    )

    const requiredRequestField = globalThis.structuredClone(baseline)
    const requestSchema =
      requiredRequestField.paths['/v1/runtimes/list'].post.requestBody.content['application/json']
        .schema
    requestSchema.properties.requiredFutureField = { type: 'string' }
    requestSchema.required.push('requiredFutureField')
    expect(findBreakingContractChanges(baseline, requiredRequestField)).toContain(
      'Request POST /v1/runtimes/list added required field requiredFutureField'
    )

    const expandedEnum = globalThis.structuredClone(baseline)
    const statusEnum =
      expandedEnum.paths['/v1/runtimes/list'].post.responses['200'].content['application/json']
        .schema.properties.data.properties.runtimes.items.properties.status.enum
    statusEnum.push('unknown')
    expect(findBreakingContractChanges(baseline, expandedEnum)).toContain(
      'Response POST /v1/runtimes/list changed closed enum at data.runtimes[].status'
    )

    const narrowedRequest = globalThis.structuredClone(baseline)
    narrowedRequest.paths['/v1/runtimes/list'].post.requestBody.content[
      'application/json'
    ].schema.properties.parameters.properties.requiredCapabilities.maxItems = 1
    expect(findBreakingContractChanges(baseline, narrowedRequest)).toContain(
      'Request POST /v1/runtimes/list changed compatibility constraint maxItems at parameters.requiredCapabilities'
    )

    const expandedResponse = globalThis.structuredClone(baseline)
    expandedResponse.paths['/v1/runtimes/list'].post.responses['200'].content[
      'application/json'
    ].schema.properties.data.properties.runtimes.items.properties.limitations.items.maxLength =
      1_024
    expect(findBreakingContractChanges(baseline, expandedResponse)).toContain(
      'Response POST /v1/runtimes/list changed compatibility constraint maxLength at data.runtimes[].limitations[]'
    )
  })

  test('requires a new major boundary instead of replacing an existing baseline', () => {
    expect(() => assertBaselineUnchanged('{"major":1}', '{"major":1}', 1)).not.toThrow()
    expect(() => assertBaselineUnchanged('{"major":1}', '{"major":1,"changed":true}', 1)).toThrow(
      'Compatibility baseline v1 is immutable'
    )
  })

  test('preserves every old request alternative and rejects constrained or narrowed unions', () => {
    const document = (schema) => ({
      paths: {
        '/test': { post: { requestBody: { content: { 'application/json': { schema } } } } },
      },
    })
    const original = { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] }
    const added = {
      type: 'object',
      properties: { inputs: { type: 'string' } },
      required: ['inputs'],
    }
    const union = { anyOf: [original, added] }
    expect(findBreakingContractChanges(document(original), document(union))).toEqual([])
    expect(findBreakingContractChanges(document(union), document(union))).toEqual([])
    expect(
      findBreakingContractChanges(document(union), document({ anyOf: [original] }))
    ).not.toEqual([])
    expect(
      findBreakingContractChanges(document(original), document({ anyOf: [added] }))
    ).not.toEqual([])
    expect(
      findBreakingContractChanges(
        document(original),
        document({ ...union, additionalProperties: false })
      )
    ).not.toEqual([])
    const narrowed = { ...original, properties: { ref: { type: 'string', maxLength: 1 } } }
    expect(
      findBreakingContractChanges(document(original), document({ anyOf: [narrowed, added] }))
    ).not.toEqual([])
  })
})

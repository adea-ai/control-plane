import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  ContextPackagePublicReferenceSchema,
  ContextAuthoringInputsSchema,
  ControlApiFixtures,
  ExecutionAcceptanceRequestSchema,
  ExecutionAcceptanceResponseSchema,
  ExecutionRequestValidationRequestSchema,
  ExecutionRequestValidationResponseSchema,
  ProfileResolutionRequestSchema,
  ProfileResolutionResponseSchema,
  ProjectStateReferenceSchema,
  RuntimeListRequestSchema,
  RuntimeListResponseSchema,
  ServiceAuthenticationRequestSchema,
  ServiceAuthenticationResponseSchema,
} from './index.ts'

describe('Agent HQ Control API contracts', () => {
  test('defines caller context inputs without accepting host-owned authority', () => {
    const input = {
      objective: 'Use bounded project context',
      candidates: [
        { itemId: 'psi_01JABCDEF0123456789ABCDEFG', itemRevision: 1, required: true, priority: 0 },
      ],
      successCriteria: ['Return evidence'],
      returnContract: { contractRef: 'contract://result/v1' },
      budgets: { maximumBytes: 1024, maximumTokens: 256 },
    }
    expect(ContextAuthoringInputsSchema.parse(input)).toEqual(input)
    for (const extra of [
      { workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG' },
      { principalRef: 'service:admin' },
      { compiledAt: '2026-09-07T00:00:00.000Z' },
      { permissions: ['admin'] },
      { artifacts: [] },
      { projectState: {} },
    ])
      expect(ContextAuthoringInputsSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    expect(
      ContextAuthoringInputsSchema.safeParse({
        ...input,
        candidates: [{ ...input.candidates[0], authorized: true }],
      }).success
    ).toBe(false)
    expect(
      ContextAuthoringInputsSchema.safeParse({
        ...input,
        budgets: { ...input.budgets, maximumBytes: 0 },
      }).success
    ).toBe(false)
  })
  test('prepares the independently installable contract package for release automation', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const releaseManifest = JSON.parse(
      await readFile(new URL('../../../.release-please-manifest.json', import.meta.url), 'utf8')
    )

    expect(manifest.name).toBe('@control-plane/contracts')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.version).toBe(releaseManifest['packages/contracts'])
    expect(manifest.license).toBe('Apache-2.0')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig).toEqual({ access: 'public', provenance: true })
  })

  test('publishes deterministic authentication and profile-resolution fixtures', () => {
    expect(
      ServiceAuthenticationRequestSchema.parse(ControlApiFixtures.authentication.request)
    ).toEqual(ControlApiFixtures.authentication.request)
    expect(
      ServiceAuthenticationResponseSchema.parse(ControlApiFixtures.authentication.response)
    ).toEqual(ControlApiFixtures.authentication.response)
    expect(
      ProfileResolutionRequestSchema.parse(ControlApiFixtures.profileResolution.request)
    ).toEqual(ControlApiFixtures.profileResolution.request)
    expect(
      ProfileResolutionResponseSchema.parse(ControlApiFixtures.profileResolution.response)
    ).toEqual(ControlApiFixtures.profileResolution.response)
  })

  test('exposes only immutable ProjectState and ContextPackage references', () => {
    expect(ProjectStateReferenceSchema.parse(ControlApiFixtures.projectStateReference)).toEqual(
      ControlApiFixtures.projectStateReference
    )
    expect(
      ContextPackagePublicReferenceSchema.parse(ControlApiFixtures.contextPackageReference)
    ).toEqual(ControlApiFixtures.contextPackageReference)

    expect(
      ProjectStateReferenceSchema.parse({
        ...ControlApiFixtures.projectStateReference,
        items: [{ key: 'secret', value: 'server-only' }],
      })
    ).toEqual(ControlApiFixtures.projectStateReference)
    expect(
      ContextPackagePublicReferenceSchema.parse({
        ...ControlApiFixtures.contextPackageReference,
        rawContext: 'server-only',
      })
    ).toEqual(ControlApiFixtures.contextPackageReference)
  })

  test('models runtime discovery without native handles or credentials', () => {
    expect(RuntimeListRequestSchema.parse(ControlApiFixtures.runtimeList.request)).toEqual(
      ControlApiFixtures.runtimeList.request
    )
    expect(RuntimeListResponseSchema.parse(ControlApiFixtures.runtimeList.response)).toEqual(
      ControlApiFixtures.runtimeList.response
    )

    const serialized = JSON.stringify(ControlApiFixtures.runtimeList.response).toLowerCase()
    for (const prohibited of [
      'credential',
      'processhandle',
      'temporal',
      'langgraph',
      'pi_',
      'acp',
    ]) {
      expect(serialized).not.toContain(prohibited)
    }
  })

  test('validates execution requests against exact #17 plan inputs and returns an immutable plan ref', () => {
    expect(
      ExecutionRequestValidationRequestSchema.parse(ControlApiFixtures.executionValidation.request)
    ).toEqual(ControlApiFixtures.executionValidation.request)
    expect(
      ExecutionRequestValidationResponseSchema.parse(
        ControlApiFixtures.executionValidation.response
      )
    ).toEqual(ControlApiFixtures.executionValidation.response)

    for (const scopeField of ['workspaceId', 'projectId']) {
      const mismatched = globalThis.structuredClone(ControlApiFixtures.executionValidation.request)
      mismatched.payload.projectState[scopeField] =
        scopeField === 'workspaceId'
          ? 'wsp_01JZBCDEF0123456789ABCDEFG'
          : 'prj_01JZBCDEF0123456789ABCDEFG'
      expect(ExecutionRequestValidationRequestSchema.safeParse(mismatched).success).toBe(false)
    }

    expect(
      ExecutionRequestValidationRequestSchema.safeParse({
        ...ControlApiFixtures.executionValidation.request,
        payload: {
          ...ControlApiFixtures.executionValidation.request.payload,
          profileVersionId: undefined,
        },
      }).success
    ).toBe(false)
    expect(
      ExecutionRequestValidationResponseSchema.parse({
        ...ControlApiFixtures.executionValidation.response,
        data: {
          ...ControlApiFixtures.executionValidation.response.data,
          executionPlan: {
            ...ControlApiFixtures.executionValidation.response.data.executionPlan,
            mutable: true,
          },
        },
      })
    ).toEqual(ControlApiFixtures.executionValidation.response)
  })

  test('accepts exactly one context source and rejects caller authority in inline inputs', () => {
    const base = ControlApiFixtures.executionValidation.request
    const contextInputs = {
      objective: 'Complete the task',
      candidates: [],
      successCriteria: ['Done'],
      returnContract: { contractRef: base.payload.outputContractRef },
      budgets: { maximumBytes: 10000, maximumTokens: 1000 },
    }
    const inline = {
      ...base,
      payload: { ...base.payload, contextPackage: undefined, contextInputs },
    }
    expect(ExecutionRequestValidationRequestSchema.safeParse(inline).success).toBe(true)
    expect(
      ExecutionRequestValidationRequestSchema.safeParse({
        ...base,
        payload: { ...base.payload, contextInputs },
      }).success
    ).toBe(false)
    expect(
      ExecutionRequestValidationRequestSchema.safeParse({
        ...base,
        payload: { ...base.payload, contextPackage: undefined },
      }).success
    ).toBe(false)
    for (const extra of [
      { authorized: true },
      { permissions: ['admin'] },
      { compiledAt: base.issuedAt },
    ]) {
      expect(
        ExecutionRequestValidationRequestSchema.safeParse({
          ...inline,
          payload: { ...inline.payload, contextInputs: { ...contextInputs, ...extra } },
        }).success
      ).toBe(false)
    }
  })

  test('accepts execution commands with durable replay and lifecycle responses', () => {
    expect(
      ExecutionAcceptanceRequestSchema.parse(ControlApiFixtures.executionAcceptance.request)
    ).toEqual(ControlApiFixtures.executionAcceptance.request)
    expect(
      ExecutionAcceptanceResponseSchema.parse(ControlApiFixtures.executionAcceptance.response)
    ).toEqual(ControlApiFixtures.executionAcceptance.response)

    for (const status of [
      'accepted',
      'processing',
      'completed',
      'failed',
      'reconciliation_required',
    ]) {
      expect(
        ExecutionAcceptanceResponseSchema.safeParse({
          ...ControlApiFixtures.executionAcceptance.response,
          data: { ...ControlApiFixtures.executionAcceptance.response.data, status },
        }).success
      ).toBe(true)
    }
    expect(
      ExecutionAcceptanceRequestSchema.safeParse({
        ...ControlApiFixtures.executionAcceptance.request,
        projectId: undefined,
      }).success
    ).toBe(false)
  })

  test('accepts additive fields without exposing them and rejects ambient scopes', () => {
    const response = ProfileResolutionResponseSchema.parse({
      ...ControlApiFixtures.profileResolution.response,
      data: {
        ...ControlApiFixtures.profileResolution.response.data,
        profile: {
          ...ControlApiFixtures.profileResolution.response.data.profile,
          optionalFutureField: 'future-compatible',
        },
      },
    })
    expect(response).toEqual(ControlApiFixtures.profileResolution.response)

    expect(
      ServiceAuthenticationResponseSchema.safeParse({
        ...ControlApiFixtures.authentication.response,
        data: {
          ...ControlApiFixtures.authentication.response.data,
          principal: {
            ...ControlApiFixtures.authentication.response.data.principal,
            scopes: ['*'],
          },
        },
      }).success
    ).toBe(false)
  })
})

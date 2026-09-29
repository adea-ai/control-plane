import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { TextEncoder } from 'node:util'
import { describe, expect, test } from 'bun:test'
import {
  ExecutionAcceptanceRequestSchema,
  ExecutionAcceptanceResponseSchema,
} from '@control-plane/contracts'
import { ExecutionPlanSchema } from '@control-plane/execution-plan'
import {
  createCertificationObjectStore,
  createCertificationContextPackage,
  createCertificationPlan,
  createCertificationProfileSeed,
  createCertificationRequest,
  createSignedServiceCredential,
  requiredEnvironment,
  runCloudCertification,
  seedCertificationPlan,
  seedCertificationProfile,
} from '../scripts/certify-m9-cloud.mjs'

const runSuffix = '01JZBCDEF0123456789ABCDEFG'
const now = new Date('2026-08-28T21:00:00.000Z')

describe('M9 live cloud certification harness', () => {
  test('declares the runtime workspace packages required by the executable entrypoint', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))

    expect(rootPackage.devDependencies['@control-plane/database']).toBe('workspace:*')
    expect(rootPackage.devDependencies['@control-plane/object-store']).toBe('workspace:*')
  })

  test('requires and applies the environment prefix to cloud certification objects', () => {
    const rawEnvironment = {
      M9_CONTROL_API_URL: 'https://control-api.example.invalid',
      M9_SERVICE_AUTH_ISSUER: 'https://certification.example.invalid',
      M9_SERVICE_AUTH_KEY_ID: 'm11-staging-test',
      M9_SERVICE_AUTH_PRIVATE_KEY_FILE: '/tmp/m11-staging-key.pem',
      DATABASE_URL: 'postgresql://app:fake-secret@example.invalid/database',
      R2_ENDPOINT: 'https://objects.example.invalid',
      R2_BUCKET: 'control-plane',
      R2_PREFIX: 'staging/',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'fake-secret',
    }
    const environment = requiredEnvironment(rawEnvironment)
    let storeConfiguration
    const store = { close() {} }

    expect(
      createCertificationObjectStore(environment, (configuration) => {
        storeConfiguration = configuration
        return store
      })
    ).toBe(store)
    expect(storeConfiguration).toMatchObject({ bucket: 'control-plane', prefix: 'staging/' })

    const withoutPrefix = { ...rawEnvironment }
    delete withoutPrefix.R2_PREFIX
    expect(() => requiredEnvironment(withoutPrefix)).toThrow(
      'M9_CERTIFICATION_CONFIGURATION_MISSING:R2_PREFIX'
    )
  })

  test('persists the context package before the execution plan that references it', async () => {
    const contextPackage = createCertificationContextPackage({
      runSuffix,
      compiledAt: now.toISOString(),
    })
    const plan = createCertificationPlan({
      runSuffix,
      compiledAt: now.toISOString(),
      contextPackage,
    })
    const writes = []

    await seedCertificationPlan(plan, contextPackage, {
      contextPackages: {
        put: async (packageToPersist) => {
          writes.push({ type: 'context-package', value: packageToPersist })
        },
      },
      plans: {
        put: async (executionPlan) => {
          writes.push({ type: 'execution-plan', value: executionPlan })
        },
      },
    })

    expect(writes).toEqual([
      { type: 'context-package', value: contextPackage },
      { type: 'execution-plan', value: plan },
    ])
  })

  test('seeds the published profile version pinned by the certification plan', async () => {
    const profileSeed = createCertificationProfileSeed({
      runSuffix,
      compiledAt: now.toISOString(),
    })
    const plan = createCertificationPlan({
      runSuffix,
      compiledAt: now.toISOString(),
      profileVersion: profileSeed.profileVersion,
    })
    const writes = []

    await seedCertificationProfile(profileSeed, {
      insertAgentProfile: async (profile) => {
        writes.push({ type: 'profile', value: profile })
        return true
      },
      insertAgentProfileVersion: async (profileVersion) => {
        writes.push({ type: 'profile-version', value: profileVersion })
        return true
      },
    })

    expect(writes).toEqual([
      { type: 'profile', value: profileSeed.profile },
      { type: 'profile-version', value: profileSeed.profileVersion },
    ])
    expect(plan.profile).toMatchObject({
      profileId: profileSeed.profile.profileId,
      profileVersionId: profileSeed.profileVersion.profileVersionId,
      contentDigest: profileSeed.profileVersion.contentDigest,
      revision: profileSeed.profileVersion.revision,
    })
  })

  test('rejects a context package that differs from the execution plan pin before writing', async () => {
    const contextPackage = createCertificationContextPackage({
      runSuffix,
      compiledAt: now.toISOString(),
    })
    const plan = createCertificationPlan({
      runSuffix,
      compiledAt: now.toISOString(),
      contextPackage,
    })
    const mismatchedContextPackage = createCertificationContextPackage({
      runSuffix,
      compiledAt: new Date(now.getTime() + 1).toISOString(),
    })
    const writes = []

    await expect(
      seedCertificationPlan(plan, mismatchedContextPackage, {
        contextPackages: { put: async () => writes.push('context-package') },
        plans: { put: async () => writes.push('execution-plan') },
      })
    ).rejects.toThrow('M9_CERTIFICATION_CONTEXT_REFERENCE_MISMATCH')
    expect(writes).toEqual([])
  })

  test('creates a current, scope-consistent certification plan and acceptance request', () => {
    const plan = createCertificationPlan({ runSuffix, compiledAt: now.toISOString() })
    const request = createCertificationRequest({ plan, runSuffix, now })

    expect(ExecutionPlanSchema.parse(plan)).toEqual(plan)
    expect(ExecutionAcceptanceRequestSchema.parse(request)).toEqual(request)
    expect(plan.outputContract.contractRef).toBe(
      'contract://control-plane/m9-cloud-certification/v1'
    )
    expect(request.payload.executionPlan).toEqual({
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    })
    expect(request.workspaceId).toBe(plan.correlation.workspaceId)
    expect(request.projectId).toBe(plan.correlation.projectId)
    expect(Date.parse(request.payload.retentionExpiresAt)).toBeGreaterThan(now.getTime())
  })

  test('signs a short-lived Ed25519 service credential without exposing key material', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const credential = createSignedServiceCredential({
      privateKey,
      issuer: 'https://m9-certification.control-plane.invalid',
      keyId: 'm9-staging-2026-08',
      runSuffix,
      now,
    })
    const [header, payload, signature] = credential.split('.')

    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true)
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toMatchObject({
      audience: 'control-plane',
      issuer: 'https://m9-certification.control-plane.invalid',
      keyId: 'm9-staging-2026-08',
      scopes: ['execution:accept'],
    })
    expect(credential).not.toContain('PRIVATE KEY')
  })

  test('proves terminal Neon state, retained R2 integrity, and idempotent API replay', async () => {
    const plan = createCertificationPlan({ runSuffix, compiledAt: now.toISOString() })
    const request = createCertificationRequest({ plan, runSuffix, now })
    const executionId = `exe_${runSuffix}`
    const artifactId = `art_${runSuffix}`
    let reads = 0
    const calls = []
    const evidence = await runCloudCertification(
      {
        plan,
        request,
        credential: 'signed-secret-value',
        objectPrefix: 'staging/',
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
      {
        seedPlan: async () => calls.push('seed'),
        acceptExecution: async (input, credential) => {
          calls.push('accept')
          expect(input).toEqual(request)
          expect(credential).toBe('signed-secret-value')
          return ExecutionAcceptanceResponseSchema.parse({
            contractVersion: request.contractVersion,
            requestId: request.requestId,
            correlation: request.correlation,
            data: {
              commandId: request.commandId,
              executionId,
              executionPlan: request.payload.executionPlan,
              status: reads === 0 ? 'processing' : 'completed',
              replayed: reads > 0,
              ...(reads > 0 ? { resultReference: artifactId } : {}),
            },
          })
        },
        readAuthoritativeState: async () => {
          reads += 1
          calls.push('state')
          return {
            command: { status: 'completed', resultReference: artifactId },
            execution: { state: 'completed', terminalResultRef: artifactId },
            attempts: [
              {
                attemptId: `att_${runSuffix}`,
                state: 'completed',
                terminalResultRef: artifactId,
              },
            ],
          }
        },
        readArtifact: async (key) => {
          calls.push('artifact')
          return certificationArtifact(key, plan, executionId, artifactId)
        },
        sleep: async () => {},
        now: () => now,
      }
    )

    expect(calls).toEqual(['seed', 'accept', 'state', 'artifact', 'accept'])
    expect(evidence).toMatchObject({
      status: 'passed',
      executionId,
      artifactId,
      commandStatus: 'completed',
      executionState: 'completed',
      attemptCount: 1,
      replayed: true,
      objectPrefix: 'staging/',
    })
    expect(JSON.stringify(evidence)).not.toContain('signed-secret-value')
  })
})

function certificationArtifact(key, plan, executionId, artifactId) {
  const attemptId = `att_${runSuffix}`
  const body = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'cloud-certification-result',
      artifactId,
      executionId,
      attemptId,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      effectKey: `wfl_${runSuffix}:execution-lifecycle-v1:dispatch`,
    })
  )
  return {
    key,
    body,
    size: body.byteLength,
    contentType: 'application/json',
    sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    metadata: { 'execution-id': executionId, 'attempt-id': attemptId },
  }
}

import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { CredentialApiFixtures } from '@control-plane/contracts'
import { RuntimeNodeIdentityRepositoryError } from '@control-plane/database'
import { createControlApiApplication } from '../application.ts'
import {
  ConfiguredCredentialRevocationChecker,
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
} from '../auth/service-authentication.ts'
import { RepositoryRuntimeNodeCredentialRevocationService } from './runtime-node-credential-revocation.service.ts'

// Route-level proofs for the RuntimeNode revocation control with a repository test double.
// The double mirrors the repository's revocation semantics; the disposable PostgreSQL proof
// that uses the real repository and gateway is in tests/runtime-node-credential-revocation.
const KEY_ID = 'runtime-node-revocation-unit'
const ISSUER = 'https://runtime-node-revocation.example'
const AUDIENCE = 'control-plane'
const NOW = '2026-10-10T12:00:00.000Z'
const WORKSPACE = CredentialApiFixtures.revoke.request.workspaceId
const OTHER_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFH'
const OPERATOR = CredentialApiFixtures.revoke.request.caller.servicePrincipalId
const CREDENTIAL_ID = 'rgc_01JABCDEF0123456789ABCDEFG'
const NODE_ID = 'rnr_01JABCDEF0123456789ABCDEFG'
const ROUTE = '/v1/runtime-node-credentials/revoke'

const keys = generateKeyPairSync('ed25519')
const verifier = new Ed25519ServiceCredentialVerifier([
  { keyId: KEY_ID, publicKey: keys.publicKey.export({ format: 'jwk' }).x },
])
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'runtime-node-revocation-unit',
}

function bearer({
  scopes = ['credential:write'],
  principalId = OPERATOR,
  workspaceIds = [WORKSPACE],
} = {}) {
  const claims = {
    audience: AUDIENCE,
    credentialId: 'credential-runtime-node-revocation-unit',
    credentialKind: 'service',
    expiresAt: '2026-10-10T13:00:00.000Z',
    issuedAt: '2026-10-10T11:59:00.000Z',
    issuer: ISSUER,
    keyId: KEY_ID,
    principalId,
    projectIds: [],
    scopes,
    workspaceIds,
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: KEY_ID })}.${encode(claims)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), keys.privateKey).toString('base64url')}`
}

function envelope(overrides = {}, payloadOverrides = {}) {
  const base = CredentialApiFixtures.revoke.request
  return {
    ...base,
    operation: 'runtime-node-credential.revoke',
    workspaceId: WORKSPACE,
    idempotencyKey: 'runtime-node-revoke-unit-0001',
    payload: { credentialId: CREDENTIAL_ID, ...payloadOverrides },
    ...overrides,
  }
}

/** A repository double with the revocation semantics the control relies on. */
function repositoryDouble(
  records = [
    {
      credentialId: CREDENTIAL_ID,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE,
      revocationVersion: 1,
      revokedAt: null,
    },
  ]
) {
  const store = new Map(records.map((record) => [record.credentialId, { ...record }]))
  const calls = []
  return {
    calls,
    store,
    async getIssuedCredential(credentialId) {
      calls.push(['get', credentialId])
      const record = store.get(credentialId)
      return record === undefined ? undefined : { ...record }
    },
    async revokeCredential(credentialId, now) {
      calls.push(['revoke', credentialId])
      const record = store.get(credentialId)
      if (record === undefined) {
        throw new RuntimeNodeIdentityRepositoryError('RUNTIME_NODE_IDENTITY_CREDENTIAL_NOT_FOUND')
      }
      if (record.revokedAt === null) {
        record.revokedAt = now.toISOString()
        record.revocationVersion += 1
      }
      return { ...record }
    },
  }
}

async function withApplication(repository, run) {
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: AUDIENCE,
      issuer: ISSUER,
      clockSkewMs: 30_000,
      now: () => new Date(NOW),
      logger: { write: () => undefined },
      verifier,
      revocationChecker: new ConfiguredCredentialRevocationChecker([]),
    }),
    runtimeNodeCredentialRevocationService:
      repository === undefined
        ? undefined
        : new RepositoryRuntimeNodeCredentialRevocationService({
            repository,
            now: () => new Date(NOW),
          }),
  })
  try {
    return await run(application)
  } finally {
    await application.close()
  }
}

function revoke(application, payload, token = bearer()) {
  return application.inject({
    method: 'POST',
    url: ROUTE,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

describe('RuntimeNode credential revocation Control API', () => {
  test('an unconfigured profile refuses revocation explicitly and touches no state', async () => {
    await withApplication(undefined, async (application) => {
      const response = await revoke(application, envelope())
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_CONFIGURED')
    })
  })

  test('an authorized revocation bumps the version once and returns the revoked metadata', async () => {
    const repository = repositoryDouble()
    await withApplication(repository, async (application) => {
      const response = await revoke(application, envelope())
      expect(response.statusCode).toBe(200)
      expect(response.json().data.credential).toEqual({
        credentialId: CREDENTIAL_ID,
        nodeId: NODE_ID,
        workspaceId: WORKSPACE,
        revocationVersion: 2,
        revokedAt: NOW,
      })
    })
    expect(repository.calls).toEqual([
      ['get', CREDENTIAL_ID],
      ['revoke', CREDENTIAL_ID],
    ])
  })

  test('a repeated revocation replays the first revocation without advancing the version', async () => {
    const repository = repositoryDouble()
    await withApplication(repository, async (application) => {
      const first = await revoke(application, envelope())
      const replay = await revoke(
        application,
        envelope({ requestId: 'req_01JABCDEF0123456789ABCDEFH' })
      )
      expect(replay.statusCode).toBe(200)
      expect(replay.json().data.credential).toEqual(first.json().data.credential)
    })
    expect(repository.store.get(CREDENTIAL_ID).revocationVersion).toBe(2)
  })

  test('a read-only principal is refused by the scope guard before any repository call', async () => {
    const repository = repositoryDouble()
    await withApplication(repository, async (application) => {
      const response = await revoke(
        application,
        envelope(),
        bearer({ scopes: ['credential:read'] })
      )
      expect(response.statusCode).toBe(403)
    })
    expect(repository.calls).toEqual([])
    expect(repository.store.get(CREDENTIAL_ID).revokedAt).toBeNull()
  })

  test('a caller other than the authenticated principal is refused before any repository call', async () => {
    const repository = repositoryDouble()
    await withApplication(repository, async (application) => {
      // The shared service guard binds the envelope caller to the authenticated principal.
      const response = await revoke(
        application,
        envelope({ caller: { servicePrincipalId: 'svc_someone-else' } })
      )
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    })
    expect(repository.calls).toEqual([])
  })

  test('the service also rejects a caller that does not match the principal it was handed', async () => {
    const repository = repositoryDouble()
    const service = new RepositoryRuntimeNodeCredentialRevocationService({ repository })
    await expect(service.revoke(envelope(), 'svc_someone-else')).rejects.toMatchObject({
      response: { code: 'RUNTIME_NODE_CREDENTIAL_CALLER_MISMATCH' },
    })
    await expect(service.revoke(envelope(), '')).rejects.toMatchObject({
      response: { code: 'RUNTIME_NODE_CREDENTIAL_CALLER_MISMATCH' },
    })
    expect(repository.calls).toEqual([])
  })

  test('an envelope workspace outside the principal scope is refused by the guard', async () => {
    const repository = repositoryDouble()
    await withApplication(repository, async (application) => {
      const response = await revoke(
        application,
        envelope({ workspaceId: OTHER_WORKSPACE }),
        bearer({ workspaceIds: [WORKSPACE] })
      )
      expect(response.statusCode).toBe(403)
    })
    expect(repository.calls).toEqual([])
  })

  test('a credential bound to another workspace is reported as not found and never revoked', async () => {
    const repository = repositoryDouble([
      {
        credentialId: CREDENTIAL_ID,
        nodeId: NODE_ID,
        workspaceId: OTHER_WORKSPACE,
        revocationVersion: 1,
        revokedAt: null,
      },
    ])
    await withApplication(repository, async (application) => {
      const response = await revoke(
        application,
        envelope({}, {}),
        bearer({ workspaceIds: [WORKSPACE, OTHER_WORKSPACE] })
      )
      expect(response.statusCode).toBe(404)
      expect(response.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_NOT_FOUND')
    })
    expect(repository.calls).toEqual([['get', CREDENTIAL_ID]])
    expect(repository.store.get(CREDENTIAL_ID).revokedAt).toBeNull()
  })

  test('an unknown credential is reported as not found without a revocation attempt', async () => {
    const repository = repositoryDouble([])
    await withApplication(repository, async (application) => {
      const response = await revoke(application, envelope())
      expect(response.statusCode).toBe(404)
    })
    expect(repository.calls).toEqual([['get', CREDENTIAL_ID]])
  })

  test('a payload that is not a RuntimeNode credential identifier is rejected as invalid', async () => {
    const repository = repositoryDouble()
    await withApplication(repository, async (application) => {
      const response = await revoke(application, envelope({}, { credentialId: 'cred_connector_1' }))
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
    })
    expect(repository.calls).toEqual([])
  })

  test('a database grant refusal is an explicit fail-closed state with no state change', async () => {
    const repository = repositoryDouble()
    repository.revokeCredential = async () => {
      throw Object.assign(new Error('permission denied for table'), { cause: { code: '42501' } })
    }
    await withApplication(repository, async (application) => {
      const response = await revoke(application, envelope())
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_PERMITTED')
      expect(JSON.stringify(response.json())).not.toContain('permission denied')
    })
    expect(repository.store.get(CREDENTIAL_ID).revokedAt).toBeNull()
  })

  test('an unexpected repository failure surfaces as unavailable without internal detail', async () => {
    const repository = repositoryDouble()
    repository.getIssuedCredential = async () => {
      throw new Error('connection reset by peer at 10.0.0.4')
    }
    await withApplication(repository, async (application) => {
      const response = await revoke(application, envelope())
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_REVOCATION_UNAVAILABLE')
      expect(JSON.stringify(response.json())).not.toContain('10.0.0.4')
    })
  })
})

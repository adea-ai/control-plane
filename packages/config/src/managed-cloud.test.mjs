import { describe, expect, test } from 'bun:test'
import { HarnessIdSchema, ModelIdSchema } from '@control-plane/contracts'
import {
  loadDatabaseCredentials,
  loadManagedCloudConfiguration,
  managedCloudEnvironmentManifest,
} from './index.ts'

const metadata = {
  APP_ENV: 'production',
  SERVICE_VERSION: '1.0.0',
  COMMIT_SHA: 'abc123',
  INSTANCE_ID: 'production-1',
}

const cloud = {
  ...metadata,
  DATABASE_URL:
    'postgresql://control_plane_app:synthetic-test-password@control-plane-db.railway.internal:5432/control_plane?sslmode=verify-full',
  CONTROL_PLANE_SECRET_ENCRYPTION_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  CONTROL_PLANE_SERVICE_AUTH_ISSUER: 'https://agent-hq.example',
  CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS: JSON.stringify([
    { keyId: 'agent-hq-2026-08', publicKey: 'A'.repeat(43) },
  ]),
  CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS: JSON.stringify(['revoked-credential']),
  RESTATE_INGRESS_URL: 'http://control-planerestate.railway.internal:8080',
  RESTATE_REQUEST_IDENTITY_PUBLIC_KEY: 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f',
  R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_BUCKET: 'ctrl-plane',
  R2_REGION: 'auto',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key-that-is-not-logged',
  R2_PREFIX: 'sandbox/qualification/',

  CONTROL_PLANE_CLOUD_RUNTIME: 'certification',
}

describe('managed cloud configuration', () => {
  test('parses the optional catalog approval policy and rejects malformed values', () => {
    const base = { ...cloud }
    expect(loadManagedCloudConfiguration(base, 'control-api').catalogApproval).toBeUndefined()
    expect(
      loadManagedCloudConfiguration(
        { ...base, CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: 'true' },
        'control-api'
      ).catalogApproval
    ).toEqual({ required: true })
    expect(
      loadManagedCloudConfiguration(
        { ...base, CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: 'true' },
        'workflow-worker'
      ).catalogApproval
    ).toEqual({ required: true })
    expect(
      loadManagedCloudConfiguration(
        {
          ...base,
          CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: 'true',
          CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED_SINCE: '2026-09-01T00:00:00.000Z',
        },
        'control-api'
      ).catalogApproval
    ).toEqual({ required: true, requiredSince: '2026-09-01T00:00:00.000Z' })
    expect(() =>
      loadManagedCloudConfiguration(
        { ...base, CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: 'yes' },
        'control-api'
      )
    ).toThrow()
    expect(() =>
      loadManagedCloudConfiguration(
        { ...base, CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: 'yes' },
        'workflow-worker'
      )
    ).toThrow()
    expect(() =>
      loadManagedCloudConfiguration(
        {
          ...base,
          CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: 'true',
          CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED_SINCE: 'not-a-date',
        },
        'control-api'
      )
    ).toThrow()
  })

  test('parses the optional pinned harness id and rejects malformed ones', () => {
    const remote = { ...cloud, CONTROL_PLANE_CLOUD_RUNTIME: 'remote' }
    const withPin = loadManagedCloudConfiguration(
      { ...remote, CONTROL_PLANE_PINNED_HARNESS_ID: 'deepseek' },
      'workflow-worker'
    )
    expect(withPin.runtime).toEqual({ mode: 'remote', pinnedHarnessId: 'deepseek' })
    const withoutPin = loadManagedCloudConfiguration(remote, 'workflow-worker')
    expect(withoutPin.runtime).toEqual({ mode: 'remote' })
    expect(() =>
      loadManagedCloudConfiguration(
        { ...remote, CONTROL_PLANE_PINNED_HARNESS_ID: 'DeepSeek!' },
        'workflow-worker'
      )
    ).toThrow()
  })

  test('parses the optional per-model harness map and rejects malformed ones', () => {
    const remote = { ...cloud, CONTROL_PLANE_CLOUD_RUNTIME: 'remote' }
    const withMap = loadManagedCloudConfiguration(
      {
        ...remote,
        CONTROL_PLANE_HARNESS_BY_MODEL: '{"deepseek-flash":"deepseek","glm-4":"zcode"}',
      },
      'workflow-worker'
    )
    expect(withMap.runtime).toEqual({
      mode: 'remote',
      harnessByModel: { 'deepseek-flash': 'deepseek', 'glm-4': 'zcode' },
    })

    // An absent map leaves today's behavior exactly.
    expect(loadManagedCloudConfiguration(remote, 'workflow-worker').runtime).toEqual({
      mode: 'remote',
    })

    // An empty map is a configured map, not an absent one.
    expect(
      loadManagedCloudConfiguration(
        { ...remote, CONTROL_PLANE_HARNESS_BY_MODEL: '{}' },
        'workflow-worker'
      ).runtime
    ).toEqual({ mode: 'remote', harnessByModel: {} })

    for (const invalid of [
      '{"deepseek flash":"deepseek"}',
      '{"": "deepseek"}',
      '{"model":"DeepSeek"}',
      '{"model":""}',
      '{"model":42}',
      '[]',
      '"deepseek"',
      'not json',
      '',
    ]) {
      expect(() =>
        loadManagedCloudConfiguration(
          { ...remote, CONTROL_PLANE_HARNESS_BY_MODEL: invalid },
          'workflow-worker'
        )
      ).toThrow()
    }
  })

  test('the map accepts exactly the ids the canonical schemas accept', () => {
    const remote = { ...cloud, CONTROL_PLANE_CLOUD_RUNTIME: 'remote' }
    for (const modelId of ['deepseek-flash', 'glm-4', 'gpt/4o', 'DeepSeek-V3']) {
      const accepted = ModelIdSchema.safeParse(modelId).success
      let loaded
      try {
        loaded = loadManagedCloudConfiguration(
          { ...remote, CONTROL_PLANE_HARNESS_BY_MODEL: JSON.stringify({ [modelId]: 'deepseek' }) },
          'workflow-worker'
        )
      } catch {
        loaded = undefined
      }
      expect(loaded?.runtime?.harnessByModel?.[modelId]).toBe(accepted ? 'deepseek' : undefined)
    }
    for (const harnessId of ['deepseek', 'zcode', 'DeepSeek', 'z code', '']) {
      const accepted = HarnessIdSchema.safeParse(harnessId).success
      let loaded
      try {
        loaded = loadManagedCloudConfiguration(
          {
            ...remote,
            CONTROL_PLANE_HARNESS_BY_MODEL: JSON.stringify({ 'deepseek-flash': harnessId }),
          },
          'workflow-worker'
        )
      } catch {
        loaded = undefined
      }
      expect(loaded?.runtime?.harnessByModel?.['deepseek-flash']).toBe(
        accepted ? harnessId : undefined
      )
    }
  })

  test('an uppercase ASCII model id is a configured key', () => {
    const remote = { ...cloud, CONTROL_PLANE_CLOUD_RUNTIME: 'remote' }
    const loaded = loadManagedCloudConfiguration(
      { ...remote, CONTROL_PLANE_HARNESS_BY_MODEL: '{"DeepSeek-V3":"deepseek"}' },
      'workflow-worker'
    )
    expect(loaded.runtime.harnessByModel?.['DeepSeek-V3']).toBe('deepseek')
  })

  test('a model id that names an inherited property is an ordinary configured key', () => {
    const remote = { ...cloud, CONTROL_PLANE_CLOUD_RUNTIME: 'remote' }
    const loaded = loadManagedCloudConfiguration(
      { ...remote, CONTROL_PLANE_HARNESS_BY_MODEL: '{"constructor":"deepseek"}' },
      'workflow-worker'
    )
    const map = loaded.runtime.harnessByModel
    expect(map['constructor']).toBe('deepseek')
    // A model id the map does not name resolves to nothing at all.
    expect(Object.hasOwn(map, 'toString')).toBe(false)
    expect(map['toString']).toBeUndefined()
    // A key that is not a model id at all is refused, including the names that
    // would be dangerous as object keys.
    for (const key of ['__proto__', 'constructor ', 'deepseek flash', '']) {
      expect(() =>
        loadManagedCloudConfiguration(
          { ...remote, CONTROL_PLANE_HARNESS_BY_MODEL: JSON.stringify({ [key]: 'deepseek' }) },
          'workflow-worker'
        )
      ).toThrow()
    }
  })

  test('publishes a per-service dependency manifest', () => {
    expect(managedCloudEnvironmentManifest()['control-api']).toContain('RESTATE_INGRESS_URL')
    expect(managedCloudEnvironmentManifest()['workflow-worker']).toContain(
      'RESTATE_REQUEST_IDENTITY_PUBLIC_KEY'
    )
    expect(managedCloudEnvironmentManifest()['workflow-worker']).not.toContain(
      'RESTATE_INGRESS_URL'
    )
    expect(managedCloudEnvironmentManifest()['workflow-worker']).toContain(
      'CONTROL_PLANE_CLOUD_RUNTIME'
    )
    expect(JSON.stringify(managedCloudEnvironmentManifest())).not.toContain(
      'RESTATE_SERVICE_AUTH_TOKEN'
    )
    expect(managedCloudEnvironmentManifest()['control-api']).toContain(
      'CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS'
    )
    expect(Object.keys(managedCloudEnvironmentManifest()).toSorted()).toEqual([
      'control-api',
      'workflow-worker',
    ])
    expect(JSON.stringify(managedCloudEnvironmentManifest())).not.toContain(
      'CONTROL_PLANE_SERVICE_AUTH_TOKEN'
    )
  })

  test('loads Railway, Restate, and R2 configuration without changing provider-neutral types', () => {
    const configuration = loadManagedCloudConfiguration(cloud, 'control-api')
    expect(configuration).toMatchObject({
      service: 'control-api',
      database: { role: 'application' },
      restate: {
        role: 'caller',
        ingressUrl: 'http://control-planerestate.railway.internal:8080',
      },
      objectStore: { bucket: 'ctrl-plane', region: 'auto', prefix: 'sandbox/qualification/' },
      serviceAuthentication: {
        audience: 'control-plane',
        issuer: 'https://agent-hq.example',
        trustedKeys: [{ keyId: 'agent-hq-2026-08', publicKey: 'A'.repeat(43) }],
        revokedCredentialIds: ['revoked-credential'],
      },
    })

    expect(loadManagedCloudConfiguration(cloud, 'workflow-worker')).toMatchObject({
      service: 'workflow-worker',
      runtime: { mode: 'certification' },
      restate: {
        role: 'endpoint',
        requestIdentityPublicKey: 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f',
      },
    })
  })

  test('qualifies the shared Railway target with separate application, migration and administration roles', () => {
    const shared = 'control-plane-db.railway.internal:5432/control_plane'
    const environment = {
      DATABASE_URL: cloud.DATABASE_URL,
      DATABASE_MIGRATION_URL: `postgresql://control_plane_migrator:synthetic-test-password@${shared}?sslmode=verify-full`,
      DATABASE_ADMIN_URL: `postgresql://control_plane_admin:synthetic-test-password@${shared}?sslmode=verify-full`,
    }
    const credentials = ['application', 'migration', 'administration'].map((role) =>
      loadDatabaseCredentials(environment, role)
    )
    for (const entry of credentials) {
      const url = new URL(entry.url)
      expect(url.hostname).toBe('control-plane-db.railway.internal')
      expect(url.pathname).toBe('/control_plane')
      expect(url.searchParams.getAll('sslmode')).toEqual(['verify-full'])
    }
    const principals = credentials.map((entry) => new URL(entry.url).username)
    expect(principals).toEqual([
      'control_plane_app',
      'control_plane_migrator',
      'control_plane_admin',
    ])
    expect(new Set(principals).size).toBe(principals.length)
  })

  test('accepts only HTTPS or Railway-private HTTP Restate ingress', () => {
    expect(() =>
      loadManagedCloudConfiguration(
        { ...cloud, RESTATE_INGRESS_URL: 'http://restate.example.com' },
        'control-api'
      )
    ).toThrow()
    expect(() =>
      loadManagedCloudConfiguration(
        { ...cloud, RESTATE_INGRESS_URL: 'http://control-planerestate.railway.internal:9070' },
        'control-api'
      )
    ).toThrow()
  })

  test('reports missing names without exposing secret values', () => {
    try {
      loadManagedCloudConfiguration({ ...cloud, R2_SECRET_ACCESS_KEY: undefined }, 'control-api')
      throw new Error('Expected configuration failure')
    } catch (error) {
      expect(error.diagnostic.missing).toContain('R2_SECRET_ACCESS_KEY')
      expect(JSON.stringify(error)).not.toContain('secret-key')
    }
  })

  test('fails closed for malformed service authentication configuration without exposing values', () => {
    const malformedTrustedKeys = '[{"keyId":"duplicate","publicKey":"not-an-ed25519-key"}]'
    const malformedRevocations = '["duplicate","duplicate"]'

    try {
      loadManagedCloudConfiguration(
        {
          ...cloud,
          CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS: malformedTrustedKeys,
          CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS: malformedRevocations,
        },
        'control-api'
      )
      throw new Error('Expected configuration failure')
    } catch (error) {
      expect(error.diagnostic.invalid).toEqual([
        'CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS',
        'CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS',
      ])
      expect(JSON.stringify(error)).not.toContain(malformedTrustedKeys)
      expect(JSON.stringify(error)).not.toContain(malformedRevocations)
    }
  })

  test('rejects an undeclared Cloud runtime mode', () => {
    expect(() =>
      loadManagedCloudConfiguration(
        { ...cloud, CONTROL_PLANE_CLOUD_RUNTIME: 'managed-pi-placeholder' },
        'workflow-worker'
      )
    ).toThrow()
  })

  test('rejects unsafe R2 environment prefixes', () => {
    for (const prefix of ['/absolute/', '../escape/', 'a//b', 'bad prefix/']) {
      expect(() =>
        loadManagedCloudConfiguration({ ...cloud, R2_PREFIX: prefix }, 'control-api')
      ).toThrow()
    }
    const withoutPrefix = { ...cloud }
    delete withoutPrefix.R2_PREFIX
    expect(
      loadManagedCloudConfiguration(withoutPrefix, 'control-api').objectStore?.prefix
    ).toBeUndefined()
  })
})

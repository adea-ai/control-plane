import { ConfigurationError } from './service.js'
import { loadDatabaseCredentials, type DatabaseCredentials } from './database.js'
import type { RawEnvironment } from './environment.js'

export const managedCloudServices = ['control-api', 'workflow-worker'] as const

export type ManagedCloudService = (typeof managedCloudServices)[number]

export interface ManagedCloudObjectStoreConfiguration {
  readonly endpoint: string
  readonly bucket: string
  readonly region: 'auto'
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** Optional environment separation prefix for staging/preview object keys. */
  readonly prefix?: string
}

export type ManagedCloudRestateConfiguration =
  | { readonly role: 'caller'; readonly ingressUrl: string }
  | { readonly role: 'endpoint'; readonly requestIdentityPublicKey: string }

export interface ManagedCloudServiceAuthenticationConfiguration {
  readonly audience: 'control-plane'
  readonly issuer: string
  readonly trustedKeys: readonly { readonly keyId: string; readonly publicKey: string }[]
  readonly revokedCredentialIds: readonly string[]
}

export interface ManagedCloudRuntimeConfiguration {
  readonly mode: 'certification' | 'disabled' | 'remote'
}

export interface ManagedCloudConfiguration {
  readonly service: ManagedCloudService
  readonly database?: DatabaseCredentials<'application'>
  readonly objectStore?: ManagedCloudObjectStoreConfiguration
  readonly restate?: ManagedCloudRestateConfiguration
  readonly runtime?: ManagedCloudRuntimeConfiguration
  readonly serviceAuthentication?: ManagedCloudServiceAuthenticationConfiguration
  readonly secretEncryptionKey: string
}

const requiredVariables: Record<ManagedCloudService, readonly string[]> = {
  'control-api': [
    'DATABASE_URL',
    'CONTROL_PLANE_SECRET_ENCRYPTION_KEY',
    'CONTROL_PLANE_SERVICE_AUTH_ISSUER',
    'CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS',
    'CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_REGION',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'RESTATE_INGRESS_URL',
  ],
  'workflow-worker': [
    'DATABASE_URL',
    'CONTROL_PLANE_SECRET_ENCRYPTION_KEY',
    'RESTATE_REQUEST_IDENTITY_PUBLIC_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_REGION',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'CONTROL_PLANE_CLOUD_RUNTIME',
  ],
}

export function managedCloudEnvironmentManifest(): Readonly<
  Record<ManagedCloudService, readonly string[]>
> {
  return requiredVariables
}

export function loadManagedCloudConfiguration(
  environment: RawEnvironment,
  service: ManagedCloudService
): ManagedCloudConfiguration {
  const missing = requiredVariables[service].filter((variable) => !environment[variable])
  const invalid: string[] = []
  const secretEncryptionKey = environment['CONTROL_PLANE_SECRET_ENCRYPTION_KEY']
  if (secretEncryptionKey !== undefined && !isEncryptionKey(secretEncryptionKey)) {
    invalid.push('CONTROL_PLANE_SECRET_ENCRYPTION_KEY')
  }
  if (missing.length || invalid.length) {
    throw new ConfigurationError({
      code: 'INVALID_MANAGED_CLOUD_CONFIGURATION',
      service,
      invalid: [...new Set(invalid)].toSorted(),
      missing: [...new Set(missing)].toSorted(),
    })
  }

  const database = requiredVariables[service].includes('DATABASE_URL')
    ? loadDatabaseCredentials(environment, 'application')
    : undefined
  const objectStore = requiredVariables[service].includes('R2_ENDPOINT')
    ? loadObjectStoreConfiguration(environment)
    : undefined
  const restate =
    service === 'control-api'
      ? loadRestateIngressConfiguration(environment)
      : service === 'workflow-worker'
        ? loadRestateEndpointConfiguration(environment)
        : undefined
  const runtime =
    service === 'workflow-worker' ? loadWorkflowRuntimeConfiguration(environment) : undefined
  const serviceAuthentication =
    service === 'control-api' ? loadServiceAuthenticationConfiguration(environment) : undefined

  return {
    service,
    ...(database === undefined ? {} : { database }),
    ...(objectStore === undefined ? {} : { objectStore }),
    ...(restate === undefined ? {} : { restate }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(serviceAuthentication === undefined ? {} : { serviceAuthentication }),
    secretEncryptionKey: secretEncryptionKey as string,
  }
}

function loadWorkflowRuntimeConfiguration(
  environment: RawEnvironment
): ManagedCloudRuntimeConfiguration {
  const mode = environment['CONTROL_PLANE_CLOUD_RUNTIME']
  if (mode !== 'certification' && mode !== 'disabled' && mode !== 'remote') {
    throw new ConfigurationError({
      code: 'INVALID_MANAGED_CLOUD_CONFIGURATION',
      invalid: ['CONTROL_PLANE_CLOUD_RUNTIME'],
      missing: [],
      component: 'runtime',
    })
  }
  return { mode }
}

function loadServiceAuthenticationConfiguration(
  environment: RawEnvironment
): ManagedCloudServiceAuthenticationConfiguration {
  const issuer = environment['CONTROL_PLANE_SERVICE_AUTH_ISSUER'] as string
  const trustedKeys = parseJsonArray(environment['CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS'])
  const revokedCredentialIds = parseJsonArray(
    environment['CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS']
  )
  const validIssuer = isHttpsUrlWithoutCredentials(issuer)
  const validKeys =
    trustedKeys !== undefined &&
    trustedKeys.length > 0 &&
    trustedKeys.length <= 32 &&
    trustedKeys.every(isTrustedServiceKey) &&
    new Set(trustedKeys.map((key) => key.keyId)).size === trustedKeys.length
  const validRevocations =
    revokedCredentialIds !== undefined &&
    revokedCredentialIds.length <= 10_000 &&
    revokedCredentialIds.every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id)
    ) &&
    new Set(revokedCredentialIds).size === revokedCredentialIds.length
  const invalid = [
    ...(!validIssuer ? ['CONTROL_PLANE_SERVICE_AUTH_ISSUER'] : []),
    ...(!validKeys ? ['CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS'] : []),
    ...(!validRevocations ? ['CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS'] : []),
  ]
  if (invalid.length > 0) {
    throw new ConfigurationError({
      code: 'INVALID_MANAGED_CLOUD_CONFIGURATION',
      invalid,
      missing: [],
      component: 'service-authentication',
    })
  }
  return {
    audience: 'control-plane',
    issuer,
    trustedKeys: trustedKeys as ManagedCloudServiceAuthenticationConfiguration['trustedKeys'],
    revokedCredentialIds: revokedCredentialIds as readonly string[],
  }
}

function parseJsonArray(value: string | undefined): unknown[] | undefined {
  if (value === undefined || value.length > 65_536) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isTrustedServiceKey(value: unknown): value is { keyId: string; publicKey: string } {
  if (typeof value !== 'object' || value === null) return false
  const keyId = Reflect.get(value, 'keyId')
  const publicKey = Reflect.get(value, 'publicKey')
  return (
    typeof keyId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(keyId) &&
    typeof publicKey === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(publicKey) &&
    Buffer.from(publicKey, 'base64url').length === 32
  )
}

function isHttpsUrlWithoutCredentials(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}

function loadObjectStoreConfiguration(
  environment: RawEnvironment
): ManagedCloudObjectStoreConfiguration {
  const endpoint = environment['R2_ENDPOINT'] as string
  const bucket = environment['R2_BUCKET'] as string
  const region = environment['R2_REGION'] as string
  const accessKeyId = environment['R2_ACCESS_KEY_ID'] as string
  const secretAccessKey = environment['R2_SECRET_ACCESS_KEY'] as string
  // Optional environment separation prefix; staging/preview environments set a distinct
  // prefix so their objects cannot be addressed with production keys in a shared bucket.
  const prefix = environment['R2_PREFIX'] === undefined ? '' : (environment['R2_PREFIX'] as string)
  const validPrefix =
    prefix === '' ||
    (/^[A-Za-z0-9._/-]{1,128}$/.test(prefix) &&
      !prefix.startsWith('/') &&
      !prefix.includes('//') &&
      !prefix.split('/').some((segment) => segment === '.' || segment === '..'))
  if (
    !isHttpsUrl(endpoint) ||
    region !== 'auto' ||
    !/^[A-Za-z0-9._-]{3,63}$/.test(bucket) ||
    !validPrefix
  ) {
    throw new ConfigurationError({
      code: 'INVALID_MANAGED_CLOUD_CONFIGURATION',
      invalid: [
        ...(!isHttpsUrl(endpoint) ? ['R2_ENDPOINT'] : []),
        ...(region !== 'auto' ? ['R2_REGION'] : []),
        ...(!/^[A-Za-z0-9._-]{3,63}$/.test(bucket) ? ['R2_BUCKET'] : []),
        ...(!validPrefix ? ['R2_PREFIX'] : []),
      ],
      missing: [],
      component: 'r2',
    })
  }
  return {
    endpoint,
    bucket,
    region: 'auto',
    accessKeyId,
    secretAccessKey,
    ...(prefix === '' ? {} : { prefix }),
  }
}

function loadRestateIngressConfiguration(
  environment: RawEnvironment
): ManagedCloudRestateConfiguration {
  const ingressUrl = environment['RESTATE_INGRESS_URL'] as string
  if (!isRestateIngressUrl(ingressUrl)) {
    throw new ConfigurationError({
      code: 'INVALID_MANAGED_CLOUD_CONFIGURATION',
      invalid: ['RESTATE_INGRESS_URL'],
      missing: [],
      component: 'restate',
    })
  }
  return { role: 'caller', ingressUrl }
}

function loadRestateEndpointConfiguration(
  environment: RawEnvironment
): ManagedCloudRestateConfiguration {
  const requestIdentityPublicKey = environment['RESTATE_REQUEST_IDENTITY_PUBLIC_KEY'] as string
  if (!/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(requestIdentityPublicKey)) {
    throw new ConfigurationError({
      code: 'INVALID_MANAGED_CLOUD_CONFIGURATION',
      invalid: ['RESTATE_REQUEST_IDENTITY_PUBLIC_KEY'],
      missing: [],
      component: 'restate',
    })
  }
  return { role: 'endpoint', requestIdentityPublicKey }
}

function isRestateIngressUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return false
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' && url.hostname.endsWith('.railway.internal') && url.port === '8080'
    )
  } catch {
    return false
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isEncryptionKey(value: string): boolean {
  if (/^[0-9a-f]{64}$/i.test(value)) return true
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  return Buffer.from(value, 'base64url').length === 32
}

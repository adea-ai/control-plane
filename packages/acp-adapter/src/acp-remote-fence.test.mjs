import { describe, expect, test } from 'bun:test'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import {
  canonicalJson,
  generateSigningKeyPair,
  hpkeOpen,
  hpkeSeal,
  signCanonical,
  signingPublicKeyOf,
  verifyCanonical,
} from './acp-remote-crypto.ts'
import {
  ACP_REMOTE_DENIAL_REASONS,
  AcpRemoteDeviceRouteSchema,
  evaluateCommandWindow,
  evaluateRouteFence,
  remoteDenialError,
} from './acp-remote-fence.ts'
import { NOW, VALID_UNTIL, routeRecord, syntheticKeys } from './acp-remote-fixtures.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const offline = { outcome: 'denied', reason: 'device_offline', fallback: 'none' }

/** Flips one base64url character inside the data (not the padding bits of the last character). */
function flipInside(encoded) {
  const index = 4
  const replacement = encoded[index] === 'A' ? 'B' : 'A'
  return `${encoded.slice(0, index)}${replacement}${encoded.slice(index + 1)}`
}

describe('secure ACP device route record', () => {
  test('accepts a public-key-only local device route', async () => {
    expect(AcpRemoteDeviceRouteSchema.safeParse(await routeRecord()).success).toBe(true)
  })

  test('rejects credential-bearing or private-key fields in the shared route record', async () => {
    const route = await routeRecord()
    expect(AcpRemoteDeviceRouteSchema.safeParse({ ...route, apiKey: 'synthetic' }).success).toBe(
      false
    )
    expect(
      AcpRemoteDeviceRouteSchema.safeParse({ ...route, deviceSigningPrivateKey: 'synthetic' })
        .success
    ).toBe(false)
  })

  test('has no cloud location: agent_hq_cloud cannot be a native executor device route', async () => {
    const route = await routeRecord()
    expect(
      AcpRemoteDeviceRouteSchema.safeParse({ ...route, location: 'agent_hq_cloud' }).success
    ).toBe(false)
  })

  test('requires revocation time exactly when the route is revoked', async () => {
    const route = await routeRecord()
    expect(AcpRemoteDeviceRouteSchema.safeParse({ ...route, status: 'revoked' }).success).toBe(
      false
    )
    expect(
      AcpRemoteDeviceRouteSchema.safeParse({
        ...route,
        status: 'revoked',
        revokedAt: '2026-08-25T12:00:10.000Z',
      }).success
    ).toBe(true)
    expect(
      AcpRemoteDeviceRouteSchema.safeParse({ ...route, revokedAt: '2026-08-25T12:00:10.000Z' })
        .success
    ).toBe(false)
  })

  test('requires Ed25519 signing keys and X25519 recipient keys of the expected shape', async () => {
    const keys = await syntheticKeys()
    const route = await routeRecord()
    expect(
      AcpRemoteDeviceRouteSchema.safeParse({
        ...route,
        deviceSigningPublicKey: keys.deviceRecipient.publicKey,
      }).success
    ).toBe(false)
    expect(
      AcpRemoteDeviceRouteSchema.safeParse({
        ...route,
        deviceEncryptionPublicKey: signingPublicKeyOf(keys.deviceSigning),
      }).success
    ).toBe(false)
  })
})

describe('route fence decisions', () => {
  test('an active, fresh, online route is allowed', async () => {
    const route = await routeRecord()
    expect(evaluateRouteFence({ route, now: new Date(NOW), transport: 'online' })).toEqual({
      outcome: 'allowed',
    })
  })

  test('an offline route is denied with an explicit no-fallback outcome', async () => {
    const route = await routeRecord()
    expect(evaluateRouteFence({ route, now: new Date(NOW), transport: 'offline' })).toEqual(offline)
  })

  test('revocation is terminal and takes precedence over offline and stale states', async () => {
    const route = await routeRecord()
    expect(
      evaluateRouteFence({
        route,
        now: new Date(NOW),
        transport: 'offline',
        revokedAt: '2026-08-25T12:00:10.000Z',
      })
    ).toEqual({ outcome: 'denied', reason: 'device_revoked', fallback: 'none' })
    expect(
      evaluateRouteFence({
        route: await routeRecord({
          status: 'revoked',
          revokedAt: '2026-08-25T12:00:10.000Z',
        }),
        now: new Date(VALID_UNTIL),
        transport: 'online',
      })
    ).toEqual({ outcome: 'denied', reason: 'device_revoked', fallback: 'none' })
  })

  test('a route whose trust record has expired is stale even when offline', async () => {
    const route = await routeRecord()
    expect(evaluateRouteFence({ route, now: new Date(VALID_UNTIL), transport: 'offline' })).toEqual(
      { outcome: 'denied', reason: 'device_stale', fallback: 'none' }
    )
  })
})

describe('command window fence', () => {
  const issuedAt = NOW
  const expiresAt = '2026-08-25T12:01:00.000Z'
  const maxLifetimeMs = 3_600_000
  const clockSkewMs = 30_000

  test('a command inside its window is allowed, including small forward clock skew', () => {
    expect(
      evaluateCommandWindow({
        issuedAt,
        expiresAt,
        now: new Date('2026-08-25T12:00:30.000Z'),
        clockSkewMs,
        maxLifetimeMs,
      })
    ).toEqual({ outcome: 'allowed' })
    expect(
      evaluateCommandWindow({
        issuedAt: '2026-08-25T12:00:20.000Z',
        expiresAt,
        now: new Date(NOW),
        clockSkewMs,
        maxLifetimeMs,
      })
    ).toEqual({ outcome: 'allowed' })
  })

  test('a command is expired at and after its expiry instant', () => {
    expect(
      evaluateCommandWindow({
        issuedAt,
        expiresAt,
        now: new Date(expiresAt),
        clockSkewMs,
        maxLifetimeMs,
      })
    ).toEqual({ outcome: 'denied', reason: 'command_expired', fallback: 'none' })
  })

  test('a command issued beyond the clock skew is not yet valid', () => {
    expect(
      evaluateCommandWindow({
        issuedAt: '2026-08-25T12:00:31.000Z',
        expiresAt: '2026-08-25T12:01:31.000Z',
        now: new Date(NOW),
        clockSkewMs,
        maxLifetimeMs,
      })
    ).toEqual({ outcome: 'denied', reason: 'command_not_yet_valid', fallback: 'none' })
  })

  test('empty or over-long command windows are invalid', () => {
    expect(
      evaluateCommandWindow({
        issuedAt,
        expiresAt: issuedAt,
        now: new Date(NOW),
        clockSkewMs,
        maxLifetimeMs,
      })
    ).toEqual({ outcome: 'denied', reason: 'command_window_invalid', fallback: 'none' })
    expect(
      evaluateCommandWindow({
        issuedAt,
        expiresAt: '2026-08-25T14:00:00.000Z',
        now: new Date(NOW),
        clockSkewMs,
        maxLifetimeMs,
      })
    ).toEqual({ outcome: 'denied', reason: 'command_window_invalid', fallback: 'none' })
  })
})

describe('typed remote denials', () => {
  test('every denial reason maps to a runtime error that names no fallback route', () => {
    for (const reason of ACP_REMOTE_DENIAL_REASONS) {
      const error = remoteDenialError({ outcome: 'denied', reason, fallback: 'none' })
      expect(error).toBeInstanceOf(RuntimeAdapterError)
      expect(error.details).toEqual({ reason, fallback: 'none' })
      expect(error.code).toMatch(/^RUNTIME_(NODE|GATEWAY)_[A-Z_]+$/)
      expect(error.code).not.toMatch(/CLOUD|REROUTE|FALLBACK/)
    }
  })

  test('offline denials are retryable unavailability, revoked denials are not', () => {
    expect(remoteDenialError(offline)).toMatchObject({
      code: 'RUNTIME_NODE_OFFLINE',
      classification: 'unavailable',
      retryable: true,
    })
    expect(
      remoteDenialError({ outcome: 'denied', reason: 'device_revoked', fallback: 'none' })
    ).toMatchObject({
      code: 'RUNTIME_NODE_REVOKED',
      classification: 'unavailable',
      retryable: false,
    })
  })
})

describe('HPKE sealing of remote ACP payloads', () => {
  test('a sealed payload opens only with the recipient key, info, and associated data', async () => {
    const keys = await syntheticKeys()
    const plaintext = encoder.encode('{"prompt":"CANARY-HPKE"}')
    const aad = encoder.encode('aad-A')
    const sealed = await hpkeSeal({
      recipientPublicKey: keys.deviceRecipient.publicKey,
      info: 'info-A',
      aad,
      plaintext,
    })
    expect(sealed.encapsulatedKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sealed.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sealed.ciphertext).not.toContain(Buffer.from(plaintext).toString('base64url'))

    const open = (override = {}) =>
      hpkeOpen({
        recipientPrivateKey: keys.deviceRecipient.keyPair.privateKey,
        info: 'info-A',
        aad,
        encapsulatedKey: sealed.encapsulatedKey,
        ciphertext: sealed.ciphertext,
        ...override,
      })

    expect(decoder.decode(await open())).toBe('{"prompt":"CANARY-HPKE"}')
    await expect(open({ aad: encoder.encode('aad-B') })).rejects.toThrow()
    await expect(open({ info: 'info-B' })).rejects.toThrow()
    await expect(
      open({ recipientPrivateKey: keys.otherRecipient.keyPair.privateKey })
    ).rejects.toThrow()
    await expect(open({ ciphertext: flipInside(sealed.ciphertext) })).rejects.toThrow()
  })
})

describe('canonical Ed25519 signatures', () => {
  test('canonical JSON is independent of object key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":1}')
    expect(canonicalJson({ a: { c: 1, d: 2 }, b: 1 })).toBe(
      canonicalJson({ b: 1, a: { d: 2, c: 1 } })
    )
  })

  test('a signature binds its domain, canonical content, and signer key', async () => {
    const keys = await syntheticKeys()
    const publicKey = signingPublicKeyOf(keys.deviceSigning)
    const signature = signCanonical('domain.v1', { a: 1, b: [2, 3] }, keys.deviceSigning)

    expect(verifyCanonical('domain.v1', { b: [2, 3], a: 1 }, signature, publicKey)).toBe(true)
    expect(verifyCanonical('domain.v2', { a: 1, b: [2, 3] }, signature, publicKey)).toBe(false)
    expect(verifyCanonical('domain.v1', { a: 2, b: [2, 3] }, signature, publicKey)).toBe(false)
    expect(
      verifyCanonical(
        'domain.v1',
        { a: 1, b: [2, 3] },
        signature,
        signingPublicKeyOf(keys.controllerSigning)
      )
    ).toBe(false)
  })

  test('freshly generated signing keys produce verifiable signatures', () => {
    const pair = generateSigningKeyPair()
    const signature = signCanonical('domain.generated', { ok: true }, pair.privateKey)
    expect(verifyCanonical('domain.generated', { ok: true }, signature, pair.publicKey)).toBe(true)
  })
})

describe('finite clock and bound validation fails closed', () => {
  const window = {
    issuedAt: NOW,
    expiresAt: '2026-08-25T12:01:00.000Z',
    now: new Date(NOW),
    clockSkewMs: 30_000,
    maxLifetimeMs: 3_600_000,
  }

  test('a non-finite command window clock fails closed instead of falling open', () => {
    expect(evaluateCommandWindow({ ...window, now: new Date(Number.NaN) })).toEqual({
      outcome: 'denied',
      reason: 'clock_invalid',
      fallback: 'none',
    })
  })

  test('malformed command timestamps and bounds fail closed', () => {
    const invalid = { outcome: 'denied', reason: 'command_window_invalid', fallback: 'none' }
    expect(evaluateCommandWindow({ ...window, issuedAt: 'not-a-timestamp' })).toEqual(invalid)
    expect(evaluateCommandWindow({ ...window, expiresAt: 'broken' })).toEqual(invalid)
    expect(evaluateCommandWindow({ ...window, clockSkewMs: Number.NaN })).toEqual(invalid)
    expect(evaluateCommandWindow({ ...window, clockSkewMs: -1 })).toEqual(invalid)
    expect(evaluateCommandWindow({ ...window, maxLifetimeMs: Number.NaN })).toEqual(invalid)
    expect(evaluateCommandWindow({ ...window, maxLifetimeMs: 0 })).toEqual(invalid)
  })

  test('a non-finite route clock or trust deadline fails closed even when online', async () => {
    const route = await routeRecord()
    const invalid = { outcome: 'denied', reason: 'clock_invalid', fallback: 'none' }
    expect(evaluateRouteFence({ route, now: new Date(Number.NaN), transport: 'online' })).toEqual(
      invalid
    )
    expect(
      evaluateRouteFence({
        route: { ...route, validUntil: 'broken' },
        now: new Date(NOW),
        transport: 'online',
      })
    ).toEqual(invalid)
    expect(
      evaluateRouteFence({
        route,
        now: new Date(NOW),
        transport: 'online',
        revokedAt: 'broken',
      })
    ).toEqual(invalid)
  })
})

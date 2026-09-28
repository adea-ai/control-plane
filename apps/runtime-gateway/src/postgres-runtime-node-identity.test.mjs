import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  runtimeNodeWebSocketChallenge,
  RuntimeNodeIdentityValidationError,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeNodeChannelAuthenticator } from './authentication.ts'
import {
  authenticateRuntimeNodeUpgrade,
  PostgresRuntimeNodeIdentityValidationPort,
  runtimeNodeIdentityTrustConfigFromEnvironment,
  runtimeNodePublicKeyThumbprint,
} from './postgres-runtime-node-identity.ts'

const websocketKey = 'dGhlIHNhbXBsZSBub25jZQ=='
const challenge = runtimeNodeWebSocketChallenge(websocketKey)
const claims = {
  schemaVersion: 1,
  credentialKind: 'runtime_node',
  credentialId: 'rgc_test_credential_0001',
  issuer: 'https://identity.example.test/runtime-nodes',
  audience: 'control-plane-runtime-gateway',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  keyId: 'rgk_test_device_0001',
  proofKeyThumbprint: '',
  revocationVersion: 1,
  channelGeneration: 1,
  issuedAt: '2026-09-28T12:00:00.000Z',
  expiresAt: '2026-09-28T12:05:00.000Z',
}

test('production upgrade verification uses operator signatures, registered device proof, and durable use', async () => {
  const issuer = generateKeyPairSync('ed25519')
  const device = generateKeyPairSync('ed25519')
  const issuerPublicPem = issuer.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const devicePublicPem = device.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const deviceThumbprint = runtimeNodePublicKeyThumbprint(devicePublicPem)
  const validClaims = { ...claims, proofKeyThumbprint: deviceThumbprint }
  const credential = issueCredential(validClaims, issuer.privateKey)
  const repository = createIdentityRepository(validClaims, devicePublicPem)
  const validator = new PostgresRuntimeNodeIdentityValidationPort(
    repository,
    new Map([['operator-issuer-v1', issuerPublicPem]])
  )
  await validator.startRevocationListener()
  const authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: validator,
    logger: { write() {} },
    now: () => new Date('2026-09-28T12:01:00.000Z'),
  })
  const proof = sign(
    null,
    Buffer.from(`${createHash('sha256').update(credential).digest('base64url')}.${challenge}`),
    device.privateKey
  ).toString('base64url')
  const request = new Request('https://gateway.example.test/runtime-gateway/v1/connect', {
    headers: {
      authorization: `RuntimeNode ${credential}`,
      'x-runtime-node-proof': proof,
      'sec-websocket-key': websocketKey,
    },
  })

  const channel = await authenticateRuntimeNodeUpgrade(request, authenticator, {
    issuer: validClaims.issuer,
    audience: validClaims.audience,
    issuerPublicKeys: new Map([['operator-issuer-v1', issuerPublicPem]]),
  })
  expect(channel.claims).toEqual(validClaims)
  expect(await validator.isRevoked(validClaims.credentialId, 1)).toBe(false)
  const replayAuthenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: validator,
    logger: { write() {} },
    now: () => new Date('2026-09-28T12:01:00.000Z'),
  })
  await expect(
    authenticateRuntimeNodeUpgrade(request, replayAuthenticator, {
      issuer: validClaims.issuer,
      audience: validClaims.audience,
      issuerPublicKeys: new Map([['operator-issuer-v1', issuerPublicPem]]),
    })
  ).rejects.toMatchObject({ code: 'RUNTIME_NODE_CREDENTIAL_REPLAYED' })

  replayAuthenticator.close()
  authenticator.close()
  await validator.close()
})

test('operator credential validation rejects altered scope, retired keys and invalid device proof', async () => {
  const issuer = generateKeyPairSync('ed25519')
  const device = generateKeyPairSync('ed25519')
  const otherDevice = generateKeyPairSync('ed25519')
  const issuerPublicPem = issuer.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const devicePublicPem = device.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const validClaims = {
    ...claims,
    proofKeyThumbprint: runtimeNodePublicKeyThumbprint(devicePublicPem),
  }
  const credential = issueCredential(validClaims, issuer.privateKey)
  const attempt = {
    credential,
    proof: {
      challenge,
      signature: sign(
        null,
        Buffer.from(`${createHash('sha256').update(credential).digest('base64url')}.${challenge}`),
        otherDevice.privateKey
      ).toString('base64url'),
    },
  }
  const repository = createIdentityRepository(validClaims, devicePublicPem)
  const validator = new PostgresRuntimeNodeIdentityValidationPort(
    repository,
    new Map([['operator-issuer-v1', issuerPublicPem]])
  )
  await expect(validator.verify(attempt)).rejects.toBeInstanceOf(RuntimeNodeIdentityValidationError)
  await expect(
    validator.verify({ ...attempt, proof: { ...attempt.proof, signature: 'abc' } })
  ).rejects.toMatchObject({
    reason: 'proof',
  })

  repository.key.status = 'retired'
  const correctProof = {
    credential,
    proof: {
      challenge,
      signature: sign(
        null,
        Buffer.from(`${createHash('sha256').update(credential).digest('base64url')}.${challenge}`),
        device.privateKey
      ).toString('base64url'),
    },
  }
  await expect(validator.verify(correctProof)).rejects.toMatchObject({ reason: 'credential' })
  await validator.close()
})

test('production validator rejects an operator credential lifetime over ten minutes', async () => {
  const issuer = generateKeyPairSync('ed25519')
  const device = generateKeyPairSync('ed25519')
  const issuerPublicPem = issuer.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const devicePublicPem = device.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const longClaims = {
    ...claims,
    expiresAt: '2026-09-28T12:11:00.000Z',
    proofKeyThumbprint: runtimeNodePublicKeyThumbprint(devicePublicPem),
  }
  const credential = issueCredential(longClaims, issuer.privateKey)
  const attempt = {
    credential,
    proof: {
      challenge,
      signature: sign(
        null,
        Buffer.from(`${createHash('sha256').update(credential).digest('base64url')}.${challenge}`),
        device.privateKey
      ).toString('base64url'),
    },
  }
  const validator = new PostgresRuntimeNodeIdentityValidationPort(
    createIdentityRepository(longClaims, devicePublicPem),
    new Map([['operator-issuer-v1', issuerPublicPem]])
  )
  await expect(validator.verify(attempt)).rejects.toMatchObject({ reason: 'credential' })
  await validator.close()
})

test('gateway trust configuration accepts public issuer keys only and bounds key sets', () => {
  const issuer = generateKeyPairSync('ed25519')
  const publicPem = issuer.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  expect(
    runtimeNodeIdentityTrustConfigFromEnvironment({
      RUNTIME_NODE_IDENTITY_ISSUER: claims.issuer,
      RUNTIME_NODE_IDENTITY_AUDIENCE: claims.audience,
      RUNTIME_NODE_IDENTITY_ISSUER_PUBLIC_KEYS_JSON: JSON.stringify({
        'operator-issuer-v1': publicPem,
      }),
    }).issuerPublicKeys.size
  ).toBe(1)
  expect(() =>
    runtimeNodeIdentityTrustConfigFromEnvironment({
      RUNTIME_NODE_IDENTITY_ISSUER: claims.issuer,
      RUNTIME_NODE_IDENTITY_AUDIENCE: claims.audience,
      RUNTIME_NODE_IDENTITY_ISSUER_PUBLIC_KEYS_JSON: JSON.stringify({
        'operator-issuer-v1': issuer.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      }),
    })
  ).toThrow('RUNTIME_NODE_PUBLIC_KEY_INVALID')
})

function issueCredential(credentialClaims, issuerPrivateKey) {
  const header = encode({ alg: 'EdDSA', typ: 'RNGC', kid: 'operator-issuer-v1' })
  const payload = encode(credentialClaims)
  const signingInput = `${header}.${payload}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), issuerPrivateKey).toString('base64url')}`
}

function createIdentityRepository(credentialClaims, devicePublicPem) {
  let consumed = false
  const key = {
    keyId: credentialClaims.keyId,
    nodeId: credentialClaims.nodeId,
    workspaceId: credentialClaims.workspaceId,
    publicKeyPem: devicePublicPem,
    thumbprint: credentialClaims.proofKeyThumbprint,
    status: 'active',
  }
  const issued = {
    credentialId: credentialClaims.credentialId,
    nodeId: credentialClaims.nodeId,
    workspaceId: credentialClaims.workspaceId,
    keyId: credentialClaims.keyId,
    claims: credentialClaims,
    revocationVersion: credentialClaims.revocationVersion,
    issuedAt: credentialClaims.issuedAt,
    expiresAt: credentialClaims.expiresAt,
    revokedAt: null,
    consumedAt: null,
  }
  return {
    key,
    getVerificationKey: async () => key,
    getIssuedCredential: async () => issued,
    isCredentialRevoked: async (credentialId, version) =>
      credentialId !== issued.credentialId ||
      version !== issued.revocationVersion ||
      issued.revokedAt !== null ||
      key.status !== 'active',
    consumeCredential: async () => {
      if (issued.revokedAt !== null) return 'revoked'
      if (consumed) return 'replayed'
      consumed = true
      issued.consumedAt = '2026-09-28T12:01:00.000Z'
      return 'consumed'
    },
    subscribeRevocations: async () => async () => undefined,
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

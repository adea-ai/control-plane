import { describe, expect, test } from 'bun:test'
import { ReferenceRuntimeNode } from '@control-plane/runtime-gateway-protocol'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import {
  RuntimeNodeAuthenticationError,
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from './authentication.js'

const now = new Date('2026-08-25T12:00:00.000Z')
const nodeId = 'rnr_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const audience = 'control-plane-runtime-gateway'
const issuer = 'https://identity.test.example'

describe('RuntimeNode channel authentication', () => {
  test('expires an established channel after its credential tolerance and cannot revive it', async () => {
    let clock = now.getTime()
    const fixture = setup(() => new Date(clock))
    const issued = fixture.authority.issueCredential(fixture.device, { channelGeneration: 1 })
    const channel = await authenticate(fixture, issued, 'challenge-expiry-lifecycle-0001')
    clock = Date.parse(issued.claims.expiresAt) + 30_000
    expect(channel.active).toBe(true)
    clock++
    await expect(channel.assertCommandAllowed(golden.command)).rejects.toMatchObject({
      code: 'RUNTIME_NODE_CREDENTIAL_EXPIRED',
    })
    expect(channel.active).toBe(false)
    expect(channel.invalidatedReason).toBe('expired')
    clock = now.getTime()
    expect(channel.active).toBe(false)
    fixture.authenticator.close()
  })

  test('establishes a device-bound channel without a user session credential', async () => {
    const fixture = setup()
    const issued = fixture.authority.issueCredential(fixture.device, { channelGeneration: 1 })
    const channel = await authenticate(fixture, issued, 'challenge-authenticate-0001')

    expect(channel.claims).toMatchObject({
      credentialKind: 'runtime_node',
      nodeId,
      workspaceId,
      channelGeneration: 1,
    })
    expect(JSON.stringify(channel.claims)).not.toMatch(/private|user.?session/i)

    const command = golden.command
    await channel.assertCommandAllowed(command)
    const referenceNode = new ReferenceRuntimeNode({ now: () => new Date(now.getTime() + 1_000) })
    expect(referenceNode.receive(command).ack.disposition).toBe('accepted')
  })

  test('fails closed for malformed, wrong audience, wrong node, wrong workspace, or invalid proof', async () => {
    const fixture = setup()
    const cases = [
      {
        code: 'RUNTIME_NODE_CREDENTIAL_MALFORMED',
        attempt: { credential: 'not-a-signed-credential', proof: { challenge: 'x' } },
      },
      {
        code: 'RUNTIME_NODE_CREDENTIAL_INVALID_AUDIENCE',
        issue: { audience: 'another-gateway' },
      },
      { code: 'RUNTIME_NODE_CREDENTIAL_NODE_MISMATCH', expected: { nodeId: otherNodeId } },
      {
        code: 'RUNTIME_NODE_CREDENTIAL_WORKSPACE_MISMATCH',
        expected: { workspaceId: otherWorkspaceId },
      },
      { code: 'RUNTIME_NODE_PROOF_INVALID', mutateProof: true },
    ]

    for (const [index, testCase] of cases.entries()) {
      const issued = fixture.authority.issueCredential(fixture.device, {
        channelGeneration: index + 1,
        ...testCase.issue,
      })
      const challenge = `challenge-rejection-${String(index).padStart(4, '0')}`
      const attempt =
        testCase.attempt ?? fixture.device.authenticationAttempt(issued.credential, challenge)
      if (testCase.mutateProof) attempt.proof.signature = `${attempt.proof.signature}invalid`
      await expect(
        fixture.authenticator.authenticate(attempt, {
          audience,
          issuer,
          nodeId,
          workspaceId,
          channelGeneration: index + 1,
          challenge,
          ...testCase.expected,
        })
      ).rejects.toMatchObject({ code: testCase.code })
    }
  })

  test('rejects expiry, credential replay, and stale channel generations', async () => {
    const fixture = setup()
    const expired = fixture.authority.issueCredential(fixture.device, {
      channelGeneration: 1,
      expiresAt: '2026-08-25T11:59:29.000Z',
      issuedAt: '2026-08-25T11:58:59.000Z',
    })
    await expect(authenticate(fixture, expired, 'challenge-expired-0001')).rejects.toMatchObject({
      code: 'RUNTIME_NODE_CREDENTIAL_EXPIRED',
    })

    const current = fixture.authority.issueCredential(fixture.device, { channelGeneration: 2 })
    await authenticate(fixture, current, 'challenge-current-0002')
    await expect(authenticate(fixture, current, 'challenge-replay-0003')).rejects.toMatchObject({
      code: 'RUNTIME_NODE_CREDENTIAL_REPLAYED',
    })

    const stale = fixture.authority.issueCredential(fixture.device, { channelGeneration: 1 })
    await expect(authenticate(fixture, stale, 'challenge-stale-0004')).rejects.toMatchObject({
      code: 'RUNTIME_NODE_CHANNEL_GENERATION_STALE',
    })
  })

  test('supports credential and device-key rotation while retiring old verification keys', async () => {
    const fixture = setup()
    const first = fixture.authority.issueCredential(fixture.device, { channelGeneration: 1 })
    const firstChannel = await authenticate(fixture, first, 'challenge-first-key-0001')
    const oldKeyCredential = fixture.authority.issueCredential(fixture.device, {
      channelGeneration: 3,
    })

    const rotatedDevice = fixture.authority.rotateDeviceKey(fixture.device)
    const rotated = fixture.authority.issueCredential(rotatedDevice, { channelGeneration: 2 })
    const rotatedChannel = await authenticate(
      { ...fixture, device: rotatedDevice },
      rotated,
      'challenge-rotated-key-0002'
    )
    expect(firstChannel.invalidatedReason).toBe('replaced')
    expect(rotatedChannel.active).toBe(true)

    fixture.authority.retireVerificationKey(fixture.device.keyId)
    await expect(
      authenticate(fixture, oldKeyCredential, 'challenge-retired-key-0003')
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_CREDENTIAL_MALFORMED' })
  })

  test('propagates revocation immediately and audits only normalized outcomes', async () => {
    const fixture = setup()
    const issued = fixture.authority.issueCredential(fixture.device, { channelGeneration: 1 })
    const channel = await authenticate(fixture, issued, 'challenge-revocation-0001')

    fixture.authority.revokeCredential(issued.claims.credentialId)
    expect(channel.active).toBe(false)
    expect(channel.invalidatedReason).toBe('revoked')
    await expect(channel.assertCommandAllowed(golden.command)).rejects.toMatchObject({
      code: 'RUNTIME_NODE_CREDENTIAL_REVOKED',
    })

    const logs = JSON.stringify(fixture.entries)
    expect(logs).toContain('runtime_node_auth.revoked')
    expect(logs).not.toContain(issued.credential)
    expect(logs).not.toContain(fixture.device.privateKey)
  })
})

function setup(clock = () => now) {
  const entries = []
  const authority = new SyntheticRuntimeNodeIdentityAuthority({ audience, issuer, now: clock })
  const device = authority.registerNode({ nodeId, workspaceId })
  const authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: authority.validationPort(),
    logger: { write: (entry) => entries.push(entry) },
    now: clock,
  })
  return { authority, authenticator, device, entries }
}

function authenticate(fixture, issued, challenge) {
  return fixture.authenticator.authenticate(
    fixture.device.authenticationAttempt(issued.credential, challenge),
    {
      audience,
      issuer,
      nodeId,
      workspaceId,
      channelGeneration: issued.claims.channelGeneration,
      challenge,
    }
  )
}

const otherNodeId = 'rnr_01JBBCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JBBCDEF0123456789ABCDEFG'

expect(RuntimeNodeAuthenticationError).toBeDefined()

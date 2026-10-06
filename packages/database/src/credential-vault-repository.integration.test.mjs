import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { CredentialVault, NeonEncryptedSecretProvider } from '@control-plane/credential-vault'
import { assertCredentialVaultRepositoryConformance } from '@control-plane/credential-vault/conformance'
import { sql } from 'drizzle-orm'
import { PostgresEncryptedSecretStore } from './credential-secret-store.ts'
import { PostgresCredentialVaultRepository } from './credential-vault-repository.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'

const workspaceId = 'wsp_01JCVPG0000000000000000000'
const canary = 'pg-credential-vault-SECRET-canary-3b9d'
const snapshot = { policyId: 'workspace-standard', version: 1, digest: `sha256:${'a'.repeat(64)}` }
const allow = {
  async authorize(request) {
    return {
      effect: 'allow',
      decisionId: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'CEDAR_PERMIT',
      policySnapshot: request.policySnapshot,
      evaluatedAt: request.context.requestedAt,
    }
  },
}

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'PostgreSQL credential vault repository',
  () => {
    let isolated

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      await isolated.migrate()
    }, integrationTestTimeout(60_000))

    afterAll(async () => {
      await isolated?.dispose()
    })

    test('satisfies the adapter-independent vault conformance sequence', async () => {
      await assertCredentialVaultRepositoryConformance(
        new PostgresCredentialVaultRepository(isolated.application),
        { secretCanary: canary }
      )
    })

    test('encrypts secrets, survives reconstruction and keeps every table free of plaintext', async () => {
      let now = '2026-10-06T10:00:00.000Z'
      const open = () =>
        new CredentialVault({
          provider: new NeonEncryptedSecretProvider({
            store: new PostgresEncryptedSecretStore(isolated.application),
            encryptionKey: 'b'.repeat(64),
            keyReference: 'control-plane-secret-encryption-key/v1',
          }),
          repository: new PostgresCredentialVaultRepository(isolated.application),
          decisionPoint: allow,
          now: () => now,
        })
      const credentialId = 'crd_01JCVPG0000000000000000001'
      await open().create({
        credentialId,
        workspaceId,
        connectorRef: 'connector:slack',
        provider: 'slack',
        secret: `${canary}-slack`,
        createdAt: now,
        createdBy: 'svc_agent-hq',
      })
      const restarted = open()
      expect(await restarted.metadata(credentialId, workspaceId)).toMatchObject({
        status: 'active',
        revision: 1,
        createdBy: 'svc_agent-hq',
      })
      const lease = await restarted.lease({
        credentialLeaseId: 'crl_01JCVPG0000000000000000001',
        credentialId,
        requestId: 'req_01JCVPG0000000000000000001',
        workspaceId,
        principalRef: 'service:tool-gateway',
        operation: 'chat.post',
        resourceRef: 'mcp/slack/chat.post',
        requestedAt: now,
        expiresAt: '2026-10-06T10:01:00.000Z',
        policySnapshot: snapshot,
      })
      expect(
        await open().use(
          lease.capabilityRef,
          { workspaceId, operation: 'chat.post', resourceRef: 'mcp/slack/chat.post' },
          (secret) => secret === `${canary}-slack`
        )
      ).toBe(true)
      now = '2026-10-06T10:02:00.000Z'
      await open().rotate(credentialId, `${canary}-slack-2`, 'svc_agent-hq', { workspaceId })

      const tables = {}
      for (const table of [
        'credentials',
        'credential_leases',
        'credential_audit_events',
        'credential_commands',
        'credential_secrets',
      ]) {
        tables[table] = await isolated.application.execute(
          sql`select to_jsonb(t)::text as value from ${sql.identifier(table)} t`
        )
        expect(tables[table].length).toBeGreaterThan(0)
      }
      expect(JSON.stringify(tables).includes(canary)).toBe(false)
    })

    test('the database bounds lease lifetime and keeps audit append-only', async () => {
      const run = async (statement) => isolated.application.execute(statement)
      await expect(
        run(sql`
          insert into credential_leases (
            credential_lease_id, capability_ref, credential_id, credential_revision, workspace_id,
            principal_ref, operation, resource_ref, status, policy_snapshot, policy_decision_id,
            issued_at, expires_at
          ) values (
            'crl_01JCVPG0000000000000000009', 'lease://crl_01JCVPG0000000000000000009/x',
            'crd_01JCVPG0000000000000000001', 1, ${workspaceId}, 'service:tool-gateway', 'op',
            'resource', 'active', '{}'::jsonb, ${`sha256:${'c'.repeat(64)}`},
            '2026-10-06T10:00:00Z', '2026-10-06T10:05:00.001Z'
          )
        `)
      ).rejects.toThrow()
      await expect(run(sql`delete from credential_audit_events`)).rejects.toThrow()
      await expect(run(sql`update credential_audit_events set reason_code = 'X'`)).rejects.toThrow()
    })

    test('concurrent creates for one connector bind exactly one credential', async () => {
      const repository = new PostgresCredentialVaultRepository(isolated.application)
      const vault = new CredentialVault({
        provider: new NeonEncryptedSecretProvider({
          store: new PostgresEncryptedSecretStore(isolated.application),
          encryptionKey: 'b'.repeat(64),
          keyReference: 'control-plane-secret-encryption-key/v1',
        }),
        repository,
        now: () => '2026-10-06T11:00:00.000Z',
      })
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          vault.create({
            credentialId: `crd_01JCVPG0000000000000000R0${index}`,
            workspaceId,
            connectorRef: 'connector:race',
            provider: 'race',
            secret: `${canary}-race-${index}`,
            createdAt: '2026-10-06T11:00:00.000Z',
          })
        )
      )
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      for (const outcome of outcomes.filter(({ status }) => status === 'rejected')) {
        expect(outcome.reason.code).toBe('CREDENTIAL_CONNECTOR_IN_USE')
      }
      const [{ count }] = await isolated.application.execute(
        sql`select count(*)::int as count from credential_secrets where locator like '%000R0_/%' or locator like '%000R0_'`
      )
      expect(count).toBe(1)
    })
  }
)

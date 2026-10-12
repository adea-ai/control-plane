import type { EncryptedSecretStore } from '@control-plane/credential-vault'
import type { PersistenceProvider } from '@control-plane/deployment'
import { json, recordId } from './record-storage.js'

/** Record namespace owned by the SQLite encrypted secret store. */
export const SQLITE_CREDENTIAL_SECRET_NAMESPACE = 'credential-secrets'

function secretRecordId(locator: string, version: string): string {
  return recordId(`${locator}\u0000${version}`)
}

/**
 * Local and Hosted `simple` encrypted secret store. It holds ciphertext, IV, auth tag and key
 * reference only, in the profile's SQLite records table, keyed by locator and secret version. It
 * is the durable counterpart of the Postgres secret store, with the same create-only semantics:
 * a second put for an existing locator and version leaves the first record in place.
 */
export class SqliteEncryptedSecretStore implements EncryptedSecretStore {
  constructor(readonly provider: Pick<PersistenceProvider, 'transaction'>) {}

  put(input: Parameters<EncryptedSecretStore['put']>[0]): Promise<void> {
    return this.provider.transaction(async (transaction) => {
      const id = secretRecordId(input.locator, input.version)
      if ((await transaction.get(SQLITE_CREDENTIAL_SECRET_NAMESPACE, id)) !== undefined) return
      await transaction.put({
        namespace: SQLITE_CREDENTIAL_SECRET_NAMESPACE,
        id,
        value: json({
          locator: input.locator,
          version: input.version,
          ciphertext: input.ciphertext,
          iv: input.iv,
          authTag: input.authTag,
          keyReference: input.keyReference,
          encryptionVersion: input.encryptionVersion,
        }),
      })
    })
  }

  get(input: Parameters<EncryptedSecretStore['get']>[0]): ReturnType<EncryptedSecretStore['get']> {
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(
        SQLITE_CREDENTIAL_SECRET_NAMESPACE,
        secretRecordId(input.locator, input.version)
      )
      if (row === undefined) return undefined
      const value = row.value as Record<string, unknown>
      if (
        value['locator'] !== input.locator ||
        value['version'] !== input.version ||
        typeof value['ciphertext'] !== 'string' ||
        typeof value['iv'] !== 'string' ||
        typeof value['authTag'] !== 'string' ||
        typeof value['keyReference'] !== 'string' ||
        (value['encryptionVersion'] !== 'aad-v1' && value['encryptionVersion'] !== 'legacy-v0')
      ) {
        throw new Error('SQLITE_CREDENTIAL_SECRET_CORRUPT')
      }
      return {
        ciphertext: value['ciphertext'],
        iv: value['iv'],
        authTag: value['authTag'],
        keyReference: value['keyReference'],
        encryptionVersion: value['encryptionVersion'],
      }
    })
  }

  delete(input: Parameters<EncryptedSecretStore['delete']>[0]): Promise<void> {
    return this.provider.transaction(async (transaction) => {
      await transaction.delete(
        SQLITE_CREDENTIAL_SECRET_NAMESPACE,
        secretRecordId(input.locator, input.version)
      )
    })
  }
}

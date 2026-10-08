import { expect, test } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { PersistentModelSelectionRepository } from '@control-plane/model-gateway'
import { connection, selection } from './model-selection-fixtures.mjs'
import { createSqliteCandidateModelStore } from './sqlite-candidate-model-store.fixture.mjs'

test('fresh candidate metadata reads match canonical CAS store across revocation and physical reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-candidate-model-store-'))
  const path = join(directory, 'state.sqlite')
  let provider, reader
  try {
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    reader = new DatabaseSync(path, { readOnly: true })
    let candidate = createSqliteCandidateModelStore(provider, reader)
    const canonical = new PersistentModelSelectionRepository(provider)
    expect(await candidate.saveConnection(0, connection)).toBe(true)
    expect(await candidate.insertSelection(selection)).toBe(true)
    const defaults = {
      workspaceId: connection.workspaceId,
      revision: 1,
      lead: { connectionRef: connection.connectionRef, providerModel: 'gpt-5' },
    }
    expect(await candidate.saveDefaults(0, defaults)).toBe(true)
    expect(await candidate.getConnection(connection.workspaceId, connection.connectionRef)).toEqual(
      await canonical.getConnection(connection.workspaceId, connection.connectionRef)
    )
    expect(await candidate.getSelection(connection.workspaceId, selection.selectionRef)).toEqual(
      await canonical.getSelection(connection.workspaceId, selection.selectionRef)
    )
    expect(await candidate.getDefaults(connection.workspaceId)).toEqual(defaults)
    expect(await candidate.listConnections(connection.workspaceId)).toEqual([connection])
    const timing = {}
    for (const [name, repository] of Object.entries({ canonical, candidate })) {
      const start = performance.now()
      for (let count = 0; count < 20; count++)
        await repository.getSelection(connection.workspaceId, selection.selectionRef)
      timing[name] = performance.now() - start
    }
    console.error(
      JSON.stringify({
        schemaVersion: 'candidate-metadata-read-probe/v1',
        reads: 20,
        elapsedMs: timing,
      })
    )
    expect(
      await candidate.saveConnection(1, { ...connection, revision: 2, status: 'revoked' })
    ).toBe(true)
    expect(
      (await candidate.getConnection(connection.workspaceId, connection.connectionRef)).status
    ).toBe('revoked')
    expect(
      await candidate.getConnection(
        `${connection.workspaceId.slice(0, -1)}H`,
        connection.connectionRef
      )
    ).toBeUndefined()
    reader.close()
    reader = undefined
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    reader = new DatabaseSync(path, { readOnly: true })
    candidate = createSqliteCandidateModelStore(provider, reader)
    expect(
      (await candidate.getConnection(connection.workspaceId, connection.connectionRef)).status
    ).toBe('revoked')
    expect(await candidate.getSelection(connection.workspaceId, selection.selectionRef)).toEqual(
      selection
    )
    expect(await candidate.saveConnection(0, connection)).toBe(false)
  } finally {
    reader?.close()
    await provider?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

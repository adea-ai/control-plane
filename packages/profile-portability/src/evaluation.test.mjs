import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SqliteEvaluationRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { observedEvaluationFixture } from './evaluation-fixture.mjs'
import {
  PersistencePortableStateSource,
  PersistencePortableStateDestination,
  exportPortableState,
  assertPortableManifest,
  createPortableRecord,
  finalizePortableManifest,
  planPortableImport,
  applyPortableImport,
} from './index.ts'

test('preserves full observed runs in portable state and rejects identity and receipt corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portable-evaluation-'))
  const source = new SqlitePersistenceProvider({ path: join(directory, 'source.sqlite') })
  const target = new SqlitePersistenceProvider({ path: join(directory, 'target.sqlite') })
  try {
    await source.migrate()
    await target.migrate()
    const run = await observedEvaluationFixture()
    await new SqliteEvaluationRepository(source).saveRun(run)
    const manifest = await exportPortableState(
      new PersistencePortableStateSource({ persistence: source, componentVersions: {} }),
      { exportId: 'evaluation-portability' }
    )
    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0]).toMatchObject({
      category: 'evaluation-run',
      revision: 0,
      value: run,
    })
    expect(assertPortableManifest(manifest)).toEqual(manifest)
    const destination = new PersistencePortableStateDestination({
      persistence: target,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const plan = await planPortableImport(manifest, destination)
    await applyPortableImport(manifest, plan, destination)
    expect(await new SqliteEvaluationRepository(target).getRun(run.evalRunId)).toEqual(run)
    for (const mutate of [
      (record) => {
        record.logicalId = `evaluation-runs/${'f'.repeat(64)}`
      },
      (record) => {
        record.revision = 1
      },
      (record) => {
        record.value.results[0].observation.observations[0].target = 'forged'
      },
    ]) {
      const changed = structuredClone(manifest.records[0])
      mutate(changed)
      const { contentDigest: _recordDigest, ...record } = changed
      const { contentDigest: _manifestDigest, ...unsigned } = manifest
      const corrupted = finalizePortableManifest({
        ...unsigned,
        records: [createPortableRecord(record)],
      })
      await expect(planPortableImport(corrupted, destination)).rejects.toThrow()
    }
    await source.transaction(async (transaction) => {
      const original = (await transaction.list('evaluation-runs'))[0]
      await transaction.put({
        namespace: 'evaluation-runs',
        id: `r-${'f'.repeat(64)}`,
        value: original.value,
      })
    })
    await expect(
      exportPortableState(
        new PersistencePortableStateSource({ persistence: source, componentVersions: {} }),
        { exportId: 'corrupted-row' }
      )
    ).rejects.toThrow()
  } finally {
    await source.close()
    await target.close()
    await rm(directory, { recursive: true, force: true })
  }
})

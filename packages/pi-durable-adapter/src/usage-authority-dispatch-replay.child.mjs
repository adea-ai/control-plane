import { readFile } from 'node:fs/promises'
import { DurableUsageLedger, PinnedModelPrice } from '@control-plane/usage-ledger'
import {
  SqlitePersistenceProvider,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { createPiDurableUsageAuthority } from './usage-authority.ts'

const inputPath = process.argv[2]
if (!inputPath) throw new Error('CHILD_FIXTURE_INPUT_REQUIRED')

const { at, authority, key, path, priceSnapshot, probe } = JSON.parse(
  await readFile(inputPath, 'utf8')
)
const provider = new SqlitePersistenceProvider({ path })
await provider.migrate()

let status
try {
  const ledger = new DurableUsageLedger({
    store: new SqliteDurableUsageStore(provider),
    now: () => at,
  })
  const price = new PinnedModelPrice(priceSnapshot, { now: () => at })
  const bridge = createPiDurableUsageAuthority({
    ledger,
    resolvePrice: async () => ({ price, maximumOutputTokens: 32 }),
    assertSpendingAuthorized: async () => ({
      authorizationRef: 'model-spend:fixture',
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      assertActive: async () => {},
    }),
  })
  await bridge.authorizeInference(authority, key)
  status = 'DISPATCH_ALLOWED'
} catch (error) {
  status = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
} finally {
  provider.close()
}

process.stdout.write(JSON.stringify({ status, probe, admissionPrompt: authority.admission.prompt }))

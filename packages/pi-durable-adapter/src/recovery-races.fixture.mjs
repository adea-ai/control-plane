// Child-process tests must read current workspace sources even when dist is stale.
// Bun's test runner omits its --tsconfig-override flag from process.execArgv.
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function writeRecoverySourceOverride(directory) {
  const packages = fileURLToPath(new URL('../../', import.meta.url))
  const paths = {}
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDirectory = join(packages, entry.name)
    const manifest = join(packageDirectory, 'package.json')
    if (!existsSync(manifest)) continue
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!metadata.name?.startsWith('@control-plane/')) continue
    for (const [subpath, conditions] of Object.entries(metadata.exports ?? {})) {
      const target =
        typeof conditions === 'string' ? conditions : (conditions.default ?? conditions.node)
      if (typeof target !== 'string' || !target.startsWith('./dist/') || !target.endsWith('.js'))
        continue
      const source = join(
        packageDirectory,
        target.replace('./dist/', 'src/').replace(/\.js$/, '.ts')
      )
      if (!existsSync(source)) continue
      const specifier = subpath === '.' ? metadata.name : `${metadata.name}/${subpath.slice(2)}`
      paths[specifier] = [source]
    }
  }
  const filename = join(directory, 'workspace-source.tsconfig.json')
  writeFileSync(
    filename,
    JSON.stringify({
      extends: join(packages, '..', 'tsconfig.base.json'),
      compilerOptions: { paths },
    })
  )
  return filename
}

export const at = '2026-10-08T00:00:00.000Z'

export const result = {
  text: 'Scripted race result',
  submissionId: 'race-result',
  usage: { inputTokens: 3, outputTokens: 4, durationMs: 2 },
  inferences: [
    {
      inferenceId: 'pi-generation:1',
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        durationMs: 2,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    },
  ],
}

// Fake engines intentionally isolate scheduler races; no provider verification is claimed.
export function fixture(directory, overrides = {}) {
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
  const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
  const request = {
    executionId,
    attemptId,
    idempotencyKey: 'race:start:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId,
      attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${attemptId}`,
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'Canonical race input',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: 'principal:one',
      scopeRef: 'scope:one',
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  }
  const options = {
    directory,
    now: () => at,
    resolveAdmission: async () => admission,
    assertAuthority: async () => {},
    resolveProvider: async () => ({
      selectionRef: admission.selection.selectionRef,
      selectionRevision: 1,
      workspaceId: plan.correlation.workspaceId,
      provider: 'scripted',
      providerModel: 'race-model',
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
      withModels: async (use) => use({}),
    }),
    authorizeInference: async () => ({
      maxOutputTokens: 10,
      maximumInputTokens: 64,
      assertActive: async () => {},
    }),
    settleUsage: async (_authority, _key, usage) => usage,
    reconcileInference: async () => 'unresolved',
    engineFactory: async () => ({
      run: async () => result,
      close: async () => {},
      cancel: async () => {},
    }),
    ...overrides,
  }
  return { request, options }
}

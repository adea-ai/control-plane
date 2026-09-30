import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reserveInstallDirectory,
  createAcpBuildEnvironment,
  pinnedAcpBuild,
  validateInstallDestination,
} from '../scripts/install-m11-codex-acp.mjs'
import { pinnedCodexNativeBuild } from '../packages/acp-adapter/src/pinned-codex-build.ts'
import {
  nativeBuildJobCount,
  nativeReleaseBuildTimeoutMs,
  normalizeCodexReleaseLock,
} from '../scripts/install-m11-codex-native.mjs'
import { createPinnedBuildCommand } from '../scripts/pinned-build-command.mjs'
import { awaitLocalWorkflowOutcome } from '../scripts/native-local-workflow.mjs'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/dist/index.js'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'

test('native Local certification observes the embedded SQLite queue without Restate HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-native-local-workflow-'))
  const local = new LocalControlPlaneComposition({ dataDirectory: directory })
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('CERTIFICATION_UNEXPECTED_RESTATE_HTTP')
  }
  try {
    await local.start()
    const manifest = await local.manifest()
    expect(manifest.topology.durableExecution).toBe('embedded-sqlite')
    expect(manifest.topology.externalServices).toBe(0)
    await expect(local.discovery.resolve('restate')).rejects.toThrow('SERVICE_ENDPOINT_NOT_FOUND')
    await local.workflow.stop()
    const at = new Date().toISOString()
    const contextPackage = contextPackageSerializationFixtures.futurePi
    const plan = createExecutionPlanTestFixture({ contextPackage })
    await local.contextPackages.put(contextPackage)
    const executionPlan = {
      ...(await local.executionPlans.put(plan)),
      schemaVersion: plan.schemaVersion,
    }
    for (const [status, executionId] of [
      ['completed', 'exe_01JABCDEF0123456789ABCDEFG'],
      ['cancelled', 'exe_01JABCDEF0123456789ABCDEFH'],
    ]) {
      await new ExecutionLifecycleService(local.executions).createExecution({
        executionId,
        correlation: plan.correlation,
        executionPlan,
        acceptedAt: at,
      })
      await local.workflowJobs.enqueue({
        workflowKey: executionId,
        input: {
          executionId,
          workflowId: `wfl_${executionId.slice(4)}`,
          executionPlan,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
        },
        at,
      })
      const [job] = await local.workflowJobs.claimDue({
        owner: 'certification',
        leaseMs: 1000,
        now: at,
        limit: 1,
      })
      expect(
        await local.workflowJobs.complete({
          workflowKey: executionId,
          owner: 'certification',
          token: job.lease.token,
          outcome: { executionId, status },
          at,
        })
      ).toBe(true)
      await expect(awaitLocalWorkflowOutcome(local, executionId, status, 100)).resolves.toEqual({
        executionId,
        status,
      })
    }
    await expect(
      awaitLocalWorkflowOutcome(local, 'exe_01JABCDEF0123456789ABCDEFG', 'cancelled', 100)
    ).rejects.toThrow('LOCAL_WORKFLOW_OUTCOME_MISMATCH')
    await expect(
      awaitLocalWorkflowOutcome(local, 'missing-workflow', 'completed', 25)
    ).rejects.toThrow('LOCAL_WORKFLOW_TIMEOUT')
    await expect(
      awaitLocalWorkflowOutcome({ durableExecution: 'restate' }, 'execution', 'completed', 100)
    ).rejects.toThrow('LOCAL_CERTIFICATION_REQUIRES_EMBEDDED_SQLITE')
  } finally {
    globalThis.fetch = originalFetch
    try {
      await local.close()
    } finally {
      try {
        local.persistence.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
})

test('native Linux builds serialize compiler jobs without changing the macOS default', () => {
  expect(nativeBuildJobCount('linux')).toBe('1')
  expect(nativeBuildJobCount('darwin')).toBe('4')
  expect(() => nativeBuildJobCount('win32')).toThrow('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
})

test('native release compilation has a bounded platform-specific deadline', () => {
  expect(nativeReleaseBuildTimeoutMs('linux')).toBe(7_200_000)
  expect(nativeReleaseBuildTimeoutMs('darwin')).toBe(3_600_000)
  expect(() => nativeReleaseBuildTimeoutMs('win32')).toThrow('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
})

test('native installer verifies its cancellation patch and rejects unpinned source locks', async () => {
  const patch = await readFile(
    new URL('../docs/evidence/fixtures/codex-0.148.0-sse-cancellation.patch', import.meta.url)
  )
  expect(createHash('sha256').update(patch).digest('hex')).toBe(pinnedCodexNativeBuild.patchSha256)
  expect(() => normalizeCodexReleaseLock(Buffer.from('version = "0.0.0"'))).toThrow(
    'CODEX_NATIVE_LOCK_MISMATCH'
  )
})

test('pinned build commands propagate failure and stop their timed-out process group', async () => {
  const run = createPinnedBuildCommand({}, 100)
  await expect(run(process.execPath, ['-e', 'process.exit(7)'], process.cwd())).rejects.toThrow(
    'PINNED_BUILD_COMMAND_FAILED'
  )
  await expect(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd())
  ).rejects.toThrow('PINNED_BUILD_COMMAND_FAILED')
})

test('ACP installer pins the reviewed accounting patch and refuses ambiguous destinations', async () => {
  const patch = await readFile(
    new URL('../docs/evidence/fixtures/codex-acp-1.7.0-prompt-usage.patch', import.meta.url)
  )
  expect(createHash('sha256').update(patch).digest('hex')).toBe(pinnedAcpBuild.patchSha256)
  for (const path of ['', '.', '/', 'relative', '/tmp/../target', '/tmp/target/'])
    expect(() => validateInstallDestination(path)).toThrow(
      'ACP_INSTALL_ABSOLUTE_NEW_DIRECTORY_REQUIRED'
    )
  expect(validateInstallDestination('/tmp/new-acp-runtime')).toBe('/tmp/new-acp-runtime')
})

test('ACP installer never overwrites a pre-existing installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-acp-install-preserve-'))
  try {
    await writeFile(join(directory, 'owner.txt'), 'existing user data')
    await expect(reserveInstallDirectory(directory)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(directory, 'owner.txt'), 'utf8')).toBe('existing user data')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ACP build isolates both user and global npm configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-acp-build-environment-'))
  try {
    const environment = await createAcpBuildEnvironment(join(directory, 'home'))
    expect(await readFile(environment.npm_config_globalconfig, 'utf8')).toBe('')
    expect(environment.npm_config_userconfig).toBe('/dev/null')
    expect(environment.HOME).toBe(join(directory, 'home'))
    expect(Object.keys(environment).toSorted()).toEqual(
      [
        'CI',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'PATH',
        'npm_config_cache',
        'npm_config_globalconfig',
        'npm_config_registry',
        'npm_config_userconfig',
      ].toSorted()
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

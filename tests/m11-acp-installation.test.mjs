import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

async function nativeReceiptFixture(directory) {
  const native = join(directory, 'native')
  const contents = Buffer.from('synthetic native bytes; never executed')
  await mkdir(join(native, 'bin'), { recursive: true })
  await writeFile(join(native, 'bin/codex'), contents)
  const manifest = {
    ...pinnedCodexNativeBuild,
    schemaVersion: 1,
    status: 'built',
    profile: 'release',
    platform: process.platform,
    arch: process.arch,
    executable: 'bin/codex',
    executableSha256: createHash('sha256').update(contents).digest('hex'),
  }
  return { native, manifest, path: join(native, 'installation.json') }
}

function invokeNativeManifestInstaller(destination, native, directory) {
  const installer = new URL('../scripts/install-m11-codex-acp.mjs', import.meta.url).href
  // Use the real Node runtime: Bun's compatibility version is not a Node-24 build.
  // A pre-fix FIFO read cannot strand the runner: this deadline kills/reaps its child.
  const child = spawnSync(
    'node',
    [
      '--input-type=module',
      '--eval',
      `import { installPinnedAcp } from ${JSON.stringify(installer)};
       try {
         await installPinnedAcp(${JSON.stringify(destination)}, ${JSON.stringify(native)});
         console.log(JSON.stringify({ accepted: true }));
       } catch (error) {
         console.log(JSON.stringify({ name: error.name, message: error.message, code: error.code }));
       }`,
    ],
    {
      cwd: directory,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 2000,
      killSignal: 'SIGKILL',
    }
  )
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(0)
  return JSON.parse(child.stdout)
}

// These exercise the actual installer, which supports only macOS/Linux.
// Every valid receipt stops at an owned existing destination before any build.
test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'ACP native manifest limits preserve regular receipts, symlinks and verification errors',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-native-receipt-'))
    const destination = join(directory, 'destination')
    try {
      const fixture = await nativeReceiptFixture(directory)
      const serialized = JSON.stringify(fixture.manifest)
      await mkdir(destination)
      await writeFile(join(destination, 'owner.txt'), 'preserve')
      const boundary = serialized + ' '.repeat(16384 - Buffer.byteLength(serialized))
      await writeFile(fixture.path, boundary)
      expect(invokeNativeManifestInstaller(destination, fixture.native, directory)).toMatchObject({
        code: 'EEXIST',
      })
      const target = join(fixture.native, 'receipt.json')
      await writeFile(target, boundary)
      await rm(fixture.path)
      await symlink(target, fixture.path)
      expect(invokeNativeManifestInstaller(destination, fixture.native, directory)).toMatchObject({
        code: 'EEXIST',
      })
      await rm(fixture.path)
      for (const [contents, expected] of [
        [boundary + ' ', 'ACP_NATIVE_MANIFEST_INVALID'],
        ['', SyntaxError],
        ['{', SyntaxError],
        ['null', TypeError],
        [
          JSON.stringify({ ...fixture.manifest, executable: '../codex' }),
          'ACP_NATIVE_PATH_MISMATCH',
        ],
        [
          JSON.stringify({ ...fixture.manifest, commit: 'wrong' }),
          'CODEX_NATIVE_MANIFEST_MISMATCH',
        ],
        [
          JSON.stringify({ ...fixture.manifest, executableSha256: '0'.repeat(64) }),
          'CODEX_NATIVE_EXECUTABLE_MISMATCH',
        ],
      ]) {
        await writeFile(fixture.path, contents)
        const error = invokeNativeManifestInstaller(destination, fixture.native, directory)
        if (typeof expected === 'string') expect(error.message).toBe(expected)
        else expect(error.name).toBe(expected.name)
        expect(await readFile(join(destination, 'owner.txt'), 'utf8')).toBe('preserve')
      }
      await rm(fixture.path)
      await mkdir(fixture.path)
      expect(invokeNativeManifestInstaller(destination, fixture.native, directory)).toMatchObject({
        message: 'ACP_NATIVE_MANIFEST_INVALID',
      })
      await rm(fixture.path, { recursive: true })
      expect(invokeNativeManifestInstaller(destination, fixture.native, directory)).toMatchObject({
        code: 'ENOENT',
      })
      expect(await readFile(join(destination, 'owner.txt'), 'utf8')).toBe('preserve')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000
)

test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'ACP native manifest FIFOs reject without writers or installation side effects',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-native-manifest-fifo-'))
    const destination = join(directory, 'destination')
    try {
      const native = join(directory, 'native')
      const manifest = join(native, 'installation.json')
      const fifo = join(directory, 'fifo')
      await mkdir(native)
      const creation = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
      expect(creation.error).toBeUndefined()
      expect(creation.status).toBe(0)
      for (const kind of ['direct', 'symlink']) {
        if (kind === 'direct') {
          const direct = spawnSync('mkfifo', [manifest], { encoding: 'utf8' })
          expect(direct.error).toBeUndefined()
          expect(direct.status).toBe(0)
        } else await symlink(fifo, manifest)
        expect(invokeNativeManifestInstaller(destination, native, directory)).toMatchObject({
          message: 'ACP_NATIVE_MANIFEST_INVALID',
        })
        expect(existsSync(destination)).toBe(false)
        await rm(manifest)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  10000
)

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

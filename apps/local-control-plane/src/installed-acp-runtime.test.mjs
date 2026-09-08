import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinnedAcpBuild } from '@control-plane/acp-adapter'
import { resolveLocalRuntimeOptions } from './index.ts'
import { verifyLocalAcpInstallation } from './installed-acp-runtime.ts'

test('Local ACP selection requires explicit paths and route declarations', () => {
  expect(() => resolveLocalRuntimeOptions({ CONTROL_PLANE_LOCAL_RUNTIME: 'codex-acp' })).toThrow(
    'LOCAL_CODEX_ACP_INSTALLATION_REQUIRED'
  )
  const environment = Object.fromEntries(
    Object.entries({
      INSTALLATION: '/tmp/acp',
      NODE: '/tmp/node',
      CWD: '/tmp/work',
      HOME: '/tmp/native-home',
      PROVIDER: 'openai',
      MODEL: 'gpt-5.4',
      MODEL_ALIAS: 'reasoning.standard',
      MODEL_CAPABILITIES: 'tool_calling,structured_output',
      PROVIDER_CLASS: 'managed',
      DATA_RESIDENCY: 'us',
    }).map(([key, value]) => [`CONTROL_PLANE_CODEX_ACP_${key}`, value])
  )
  environment.CONTROL_PLANE_LOCAL_RUNTIME = 'codex-acp'
  const repositories = { catalog: {}, contextPackages: {}, dataDirectory: '/tmp/local' }
  expect(resolveLocalRuntimeOptions(environment).runtimeFactory(repositories).transportKind).toBe(
    'direct-local'
  )
  environment.CONTROL_PLANE_CODEX_ACP_CWD = 'relative'
  expect(() => resolveLocalRuntimeOptions(environment).runtimeFactory(repositories)).toThrow(
    'ACP_LOCAL_ABSOLUTE_PATH_REQUIRED'
  )
})

test('Local ACP rejects unpinned manifests and changed executables before launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-acp-launch-rejection-'))
  try {
    await writeFile(join(directory, 'installation.json'), '{}')
    await expect(verifyLocalAcpInstallation(directory)).rejects.toThrow(
      'ACP_INSTALL_MANIFEST_MISMATCH'
    )
    await writeFile(
      join(directory, 'installation.json'),
      JSON.stringify({
        ...pinnedAcpBuild,
        status: 'built',
        executable: 'source/dist/index.js',
        executableSha256: pinnedAcpBuild.bundleSha256,
      })
    )
    await mkdir(join(directory, 'source/dist'), { recursive: true })
    await writeFile(join(directory, 'source/dist/index.js'), 'not the pinned executable')
    await expect(verifyLocalAcpInstallation(directory)).rejects.toThrow(
      'ACP_INSTALL_BUNDLE_MISMATCH'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

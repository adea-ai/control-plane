import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('published SDK artifacts', () => {
  test('install and type-check without Control Plane repository source access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sdk-consumer-'))
    temporaryDirectories.push(directory)
    const contractsTarball = join(directory, 'contracts.tgz')
    const sdkTarball = join(directory, 'sdk.tgz')
    const runtimeSdkTarball = join(directory, 'runtime-sdk.tgz')

    pack(join(workspaceRoot, 'packages/contracts'), directory, 'contracts.tgz')
    pack(join(workspaceRoot, 'packages/runtime-sdk'), directory, 'runtime-sdk.tgz')
    pack(join(workspaceRoot, 'packages/control-sdk'), directory, 'sdk.tgz')

    const archiveEntries = execFileSync('tar', ['-tzf', sdkTarball], { encoding: 'utf8' })
    expect(archiveEntries).toContain('package/dist/index.js')
    expect(archiveEntries).toContain('package/dist/testing.js')
    expect(archiveEntries).toContain('package/openapi/control-plane.v2.json')
    expect(archiveEntries).toContain('package/openapi/control-plane.v3.json')
    expect(archiveEntries).not.toContain('package/src/')
    expect(archiveEntries).not.toContain('compatibility/')

    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'standalone-sdk-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@control-plane/contracts': `file:${contractsTarball}`,
          '@control-plane/runtime-sdk': `file:${runtimeSdkTarball}`,
          '@control-plane/sdk': `file:${sdkTarball}`,
        },
        overrides: {
          '@control-plane/contracts': `file:${contractsTarball}`,
          '@control-plane/runtime-sdk': `file:${runtimeSdkTarball}`,
        },
      })
    )
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['consumer.ts'],
      })
    )
    await writeFile(
      join(directory, 'consumer.ts'),
      [
        "import { ControlApiFixtures, ControlPlaneClient, type ExecutionRequestValidationRequest } from '@control-plane/sdk'",
        "import type { PiDurableLeadDispatchRequest, PiDurableLeadStatusRequest, PiDurableLeadProgressRequest, PiDurableLeadCancelRequest } from '@control-plane/runtime-sdk'",
        "import { createControlPlaneStub } from '@control-plane/sdk/testing'",
        'const request: ExecutionRequestValidationRequest = ControlApiFixtures.executionValidation.request',
        "const client = new ControlPlaneClient({ baseUrl: 'https://control-plane.example', credential: 'credential' })",
        'void client.validateExecutionRequest(request)',
        'declare const dispatch: PiDurableLeadDispatchRequest',
        'declare const status: PiDurableLeadStatusRequest',
        'declare const progress: PiDurableLeadProgressRequest',
        'declare const cancel: PiDurableLeadCancelRequest',
        'void client.dispatchPiDurableLead(dispatch)',
        'void client.getPiDurableLeadStatus(status)',
        'void client.getPiDurableLeadProgress(progress)',
        'void client.cancelPiDurableLead(cancel)',
        'void createControlPlaneStub',
      ].join('\n')
    )

    execFileSync('bun', ['install', '--ignore-scripts'], { cwd: directory, stdio: 'pipe' })
    execFileSync(join(workspaceRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
      cwd: directory,
      stdio: 'pipe',
      env: {
        ...globalThis.process.env,
        PATH: `${join(workspaceRoot, 'node_modules/.bin')}${delimiter}${globalThis.process.env.PATH ?? ''}`,
      },
    })
    execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        "await import('@control-plane/sdk'); await import('@control-plane/sdk/testing')",
      ],
      { cwd: directory, stdio: 'pipe' }
    )
  }, 60_000)
})

function pack(packageDirectory, destination, filename) {
  execFileSync(
    'bun',
    ['pm', 'pack', '--ignore-scripts', '--filename', join(destination, filename)],
    { cwd: packageDirectory, stdio: 'pipe' }
  )
}

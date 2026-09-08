import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { pinnedAcpBuild, verifyPinnedCodexNativeBinary } from '@control-plane/acp-adapter'
import { createExecutionId } from '@control-plane/control-api'
import { createLocalAcpRuntime, createRepositoryAcpTaskPromptResolver } from './acp-runtime.js'
import type { LocalManagedPiRuntimeRepositories } from './managed-pi-runtime.js'
import { LocalRuntimeModelRoute, type LocalModelRouteOptions } from './runtime-model-route.js'

export interface InstalledLocalAcpOptions extends LocalModelRouteOptions {
  readonly installationDirectory: string
  readonly nodeExecutable: string
  readonly cwd: string
  readonly codexHome: string
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size > limit) throw new Error('ACP_INSTALL_FILE_INVALID')
  const value = await readFile(path)
  if (value.length > limit) throw new Error('ACP_INSTALL_FILE_INVALID')
  return value
}

export async function verifyLocalAcpInstallation(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('ACP_INSTALL_ABSOLUTE_PATH_REQUIRED')
  const manifest = JSON.parse(
    (await boundedFile(join(directory, 'installation.json'), 16384)).toString()
  )
  if (manifest.status !== 'built' || manifest.executable !== 'source/dist/index.js')
    throw new Error('ACP_INSTALL_MANIFEST_MISMATCH')
  for (const [key, value] of Object.entries(pinnedAcpBuild)) {
    if (manifest[key] !== value) throw new Error('ACP_INSTALL_MANIFEST_MISMATCH')
  }
  const executable = join(directory, 'source/dist/index.js')
  const digest = createHash('sha256')
    .update(await boundedFile(executable, 2097152))
    .digest('hex')
  if (digest !== pinnedAcpBuild.bundleSha256 || digest !== manifest.executableSha256)
    throw new Error('ACP_INSTALL_BUNDLE_MISMATCH')
  const codex = JSON.parse(
    (
      await boundedFile(join(directory, 'source/node_modules/@openai/codex/package.json'), 65536)
    ).toString()
  )
  if (codex.version !== pinnedAcpBuild.codexVersion)
    throw new Error('ACP_INSTALL_CODEX_VERSION_MISMATCH')
  if (manifest.nativeBuild?.executable !== 'native/codex')
    throw new Error('ACP_NATIVE_REBUILD_REQUIRED')
  await verifyPinnedCodexNativeBinary(join(directory, 'native/codex'), manifest.nativeBuild)
  return executable
}

/** No install, authentication, ambient environment or native instruction replacement at startup. */
export function createInstalledLocalAcpRuntime(
  repositories: LocalManagedPiRuntimeRepositories,
  optionsInput: InstalledLocalAcpOptions
) {
  const options = { ...optionsInput, modelCapabilities: [...optionsInput.modelCapabilities] }
  for (const path of [
    options.installationDirectory,
    options.nodeExecutable,
    options.cwd,
    options.codexHome,
  ]) {
    if (!isAbsolute(path)) throw new Error('ACP_LOCAL_ABSOLUTE_PATH_REQUIRED')
  }
  const route = new LocalRuntimeModelRoute(options, 'ACP')
  const home = join(repositories.dataDirectory, 'acp-home')
  const environment = {
    PATH: `${dirname(options.nodeExecutable)}:/usr/bin:/bin`,
    HOME: home,
    CODEX_HOME: options.codexHome,
    CODEX_PATH: join(options.installationDirectory, 'native/codex'),
    CODEX_CONFIG: JSON.stringify({ model: route.model, model_provider: route.provider }),
    MODEL_PROVIDER: route.provider,
  }
  const runtime = createLocalAcpRuntime({
    executablePath: options.nodeExecutable,
    args: [join(options.installationDirectory, 'source/dist/index.js')],
    cwd: options.cwd,
    environment,
    externalSessionId: () => `ses_${createExecutionId().slice(4)}`,
    interactionId: () => `int_${createExecutionId().slice(4)}`,
    resolvePrompt: createRepositoryAcpTaskPromptResolver(
      repositories.contextPackages,
      repositories.catalog,
      route
    ),
  })
  const open = runtime.open
  return Object.assign(runtime, {
    open: async () => {
      await verifyLocalAcpInstallation(options.installationDirectory)
      await mkdir(home, { recursive: true, mode: 0o700 })
      const version = await promisify(execFile)(options.nodeExecutable, ['--version'], {
        cwd: options.cwd,
        env: environment,
        timeout: 5000,
        maxBuffer: 4096,
      })
      if (!/^v24\.\d+\.\d+\s*$/.test(version.stdout)) throw new Error('ACP_LOCAL_NODE_24_REQUIRED')
      await open()
    },
  })
}

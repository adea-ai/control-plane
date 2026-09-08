import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { pinnedAcpBuild } from '../packages/acp-adapter/src/pinned-codex-build.ts'
export { pinnedAcpBuild }

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function validateInstallDestination(destination) {
  if (
    !destination ||
    !isAbsolute(destination) ||
    resolve(destination) !== destination ||
    dirname(destination) === destination
  )
    throw new Error('ACP_INSTALL_ABSOLUTE_NEW_DIRECTORY_REQUIRED')
  return destination
}

export async function reserveInstallDirectory(destination) {
  validateInstallDestination(destination)
  await mkdir(destination, { mode: 0o700 })
}

export async function createAcpBuildEnvironment(buildHome) {
  await mkdir(buildHome, { mode: 0o700 })
  const globalConfig = join(buildHome, 'npm-global-config')
  await writeFile(globalConfig, '', { mode: 0o600, flag: 'wx' })
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: buildHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: globalConfig,
    npm_config_registry: 'https://registry.npmjs.org',
    npm_config_cache: join(buildHome, 'npm-cache'),
    CI: 'true',
  }
}

/** Explicit opt-in build; never overwrites an installation or reads user npm/git credentials. */
export async function installPinnedAcp(destinationInput) {
  const destination = validateInstallDestination(destinationInput)
  if (process.versions.node.split('.')[0] !== '24') throw new Error('ACP_INSTALL_NODE_24_REQUIRED')
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('ACP_INSTALL_PLATFORM_UNSUPPORTED')
  const patch = fileURLToPath(
    new URL('../docs/evidence/fixtures/codex-acp-1.7.0-prompt-usage.patch', import.meta.url)
  )
  if (digest(await readFile(patch)) !== pinnedAcpBuild.patchSha256)
    throw new Error('ACP_INSTALL_PATCH_MISMATCH')
  // Exclusive reservation: an existing file, symlink or directory is never modified.
  await reserveInstallDirectory(destination)
  const source = join(destination, 'source')
  const buildHome = join(destination, '.build-home')
  const environment = await createAcpBuildEnvironment(buildHome)
  const run = (command, args, cwd = source) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: environment,
        stdio: ['ignore', 'pipe', 'inherit'],
        detached: true,
      })
      const stop = () => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') reject(error)
        }
      }
      const timer = setTimeout(stop, 600000)
      timer.unref()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      const dispose = () => {
        clearTimeout(timer)
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
      let output = ''
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk)
        output = (output + chunk).slice(-1048576)
      })
      child.on('error', (error) => {
        dispose()
        reject(error)
      })
      child.on('close', (code) => {
        dispose()
        if (code === 0) resolveRun(output.trim())
        else reject(new Error(`ACP_INSTALL_COMMAND_FAILED:${command}:${code}`))
      })
    })
  // Failed builds stay in their newly reserved directory, without a ready manifest,
  // for inspection. No cleanup can erase an existing user-selected installation.
  await run(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      pinnedAcpBuild.tag,
      '--no-checkout',
      pinnedAcpBuild.repository,
      source,
    ],
    destination
  )
  if ((await run('git', ['rev-parse', 'HEAD'])) !== pinnedAcpBuild.commit)
    throw new Error('ACP_INSTALL_COMMIT_MISMATCH')
  await run('git', ['checkout', '--detach', pinnedAcpBuild.commit])
  if (digest(await readFile(join(source, 'package-lock.json'))) !== pinnedAcpBuild.lockSha256)
    throw new Error('ACP_INSTALL_LOCK_MISMATCH')
  await run('git', ['apply', '--unidiff-zero', '--check', patch])
  await run('git', ['apply', '--unidiff-zero', patch])
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
  const codex = JSON.parse(
    await readFile(join(source, 'node_modules/@openai/codex/package.json'), 'utf8')
  )
  if (codex.version !== pinnedAcpBuild.codexVersion)
    throw new Error('ACP_INSTALL_CODEX_VERSION_MISMATCH')
  await run('npm', ['run', 'typecheck'])
  await run(process.execPath, [
    join(source, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--no-file-parallelism',
    '--retry=0',
  ])
  await run('npm', ['run', 'build'])
  const executablePath = join(source, 'dist/index.js')
  const executableSha256 = digest(await readFile(executablePath))
  if (executableSha256 !== pinnedAcpBuild.bundleSha256)
    throw new Error('ACP_INSTALL_BUNDLE_MISMATCH')
  await chmod(executablePath, 0o700)
  const manifest = {
    schemaVersion: 1,
    status: 'built',
    ...pinnedAcpBuild,
    nodeVersion: process.versions.node,
    executable: 'source/dist/index.js',
    executableSha256,
    nativeCertification: 'required-before-supported-launcher-promotion',
  }
  await writeFile(
    join(destination, 'installation.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' }
  )
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/install-m11-codex-acp.mjs /absolute/new/directory')
  console.log(JSON.stringify(await installPinnedAcp(process.argv[2]), null, 2))
}

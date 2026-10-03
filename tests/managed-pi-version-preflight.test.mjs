import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { preflightManagedPiVersion } from '../infrastructure/containers/managed-pi/version-preflight.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'

test('managed Pi startup preflight uses the pinned version, a bounded direct spawn, and minimal env', () => {
  let invocation
  const result = preflightManagedPiVersion({
    executablePath: '/usr/local/bin/pi',
    agentDirectory: '/var/lib/control-plane/pi-agent',
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    run(executable, args, options) {
      invocation = { executable, args, options }
      return { status: 0, stdout: '1.0.0\n', stderr: '' }
    },
  })

  assert.deepEqual(result, { ok: true, version: '1.0.0' })
  assert.deepEqual(invocation, {
    executable: '/usr/local/bin/pi',
    args: ['--version'],
    options: {
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: 16_384,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        PI_CODING_AGENT_DIR: '/var/lib/control-plane/pi-agent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  })
})

test('managed Pi startup preflight maps timeouts without exposing child output', () => {
  const result = preflightManagedPiVersion({
    executablePath: '/usr/local/bin/pi',
    agentDirectory: '/var/lib/control-plane/pi-agent',
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    run() {
      return {
        status: null,
        stdout: 'fixture-secret-from-stdout',
        stderr: 'fixture-secret-from-stderr',
        error: Object.assign(new Error('fixture-secret-from-error'), { code: 'ETIMEDOUT' }),
      }
    },
  })

  assert.deepEqual(result, { ok: false, code: 'PI_VERSION_PREFLIGHT_TIMEOUT' })
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/)
})

test('managed Pi startup preflight maps process errors without exposing child output', () => {
  const result = preflightManagedPiVersion({
    executablePath: '/usr/local/bin/pi',
    agentDirectory: '/var/lib/control-plane/pi-agent',
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    run() {
      return {
        status: null,
        stdout: '',
        stderr: 'fixture-secret-from-stderr',
        error: Object.assign(new Error('fixture-secret-from-error'), { code: 'ENOENT' }),
      }
    },
  })

  assert.deepEqual(result, { ok: false, code: 'PI_VERSION_PREFLIGHT_PROCESS_ERROR' })
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/)
})

test('managed Pi startup preflight rejects a runtime version other than the exact pinned version', () => {
  const result = preflightManagedPiVersion({
    executablePath: '/usr/local/bin/pi',
    agentDirectory: '/var/lib/control-plane/pi-agent',
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    run() {
      return { status: 0, stdout: '0.84.3\n', stderr: 'fixture-secret-from-stderr' }
    },
  })

  assert.deepEqual(result, { ok: false, code: 'PI_VERSION_PREFLIGHT_VERSION_MISMATCH' })
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/)
})

test('managed Pi startup preflight bounds output and never returns it on failure', () => {
  const result = preflightManagedPiVersion({
    executablePath: '/usr/local/bin/pi',
    agentDirectory: '/var/lib/control-plane/pi-agent',
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    run() {
      return { status: 0, stdout: 'x'.repeat(16_385), stderr: 'fixture-secret-from-stderr' }
    },
  })

  assert.deepEqual(result, { ok: false, code: 'PI_VERSION_PREFLIGHT_OUTPUT_TOO_LARGE' })
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|x{100}/)
})

test('managed Pi startup preflight sanitizes nonzero child exits', () => {
  const result = preflightManagedPiVersion({
    executablePath: '/usr/local/bin/pi',
    agentDirectory: '/var/lib/control-plane/pi-agent',
    pathValue: '/usr/local/bin:/usr/bin:/bin',
    run() {
      return { status: 17, stdout: '', stderr: 'fixture-secret-from-stderr' }
    },
  })

  assert.deepEqual(result, { ok: false, code: 'PI_VERSION_PREFLIGHT_PROCESS_FAILED' })
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/)
})

test('managed Pi preflight CLI emits only a sanitized code when Pi reports a mismatched version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-pi-version-preflight-'))
  const fakePi = join(directory, 'pi')
  const helper = fileURLToPath(
    new URL('../infrastructure/containers/managed-pi/version-preflight.mjs', import.meta.url)
  )

  try {
    await writeFile(fakePi, '#!/bin/sh\nprintf "0.84.3\\n"\nprintf "fixture-secret\\n" >&2\n', {
      mode: 0o700,
    })
    await chmod(fakePi, 0o700)
    const cli = Bun.spawnSync(['node', helper, fakePi], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        PI_CODING_AGENT_DIR: directory,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    assert.equal(cli.exitCode, 1)
    assert.equal(cli.stdout.toString(), '')
    assert.equal(cli.stderr.toString().trim(), 'PI_VERSION_PREFLIGHT_VERSION_MISMATCH')
    assert.doesNotMatch(cli.stderr.toString(), /fixture-secret|0\.84\.3/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)

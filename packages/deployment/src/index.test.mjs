import { join } from 'node:path'
import { writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { DeploymentProfiles, NodeProcessRuntimeProvider } from './index.ts'

describe('deployment profile contracts', () => {
  test('publishes exactly the accepted product profiles', () => {
    expect(Object.values(DeploymentProfiles)).toEqual([
      'cloud',
      'local',
      'hosted-simple',
      'hosted-server',
    ])
  })

  test('keeps the profile catalog immutable', () => {
    expect(Object.isFrozen(DeploymentProfiles)).toBe(true)
  })
})

describe('managed spawn policy (CP-RNODE-025)', () => {
  const provider = (policy) =>
    new NodeProcessRuntimeProvider({ spawnPolicy: policy, stopTimeoutMs: 1000 })

  test('allows launches inside the policy and rejects policy violations before spawning', async () => {
    const script = join(tmpdir(), 'm11-policy-allowed.sh')
    await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const outside = join(tmpdir(), 'm11-policy-outside.sh')
    await writeFile(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    try {
      const constrained = provider({
        allowedExecutables: [script],
        allowedWorkingDirectories: [tmpdir()],
        maximumArguments: 3,
        maximumArgumentLength: 64,
        maximumEnvironmentVariables: 2,
      })
      const handle = await constrained.launch({
        executable: script,
        args: ['-x'],
        cwd: tmpdir(),
        environment: { MANAGED_FLAG: '1' },
      })
      await handle.stop()
      await expect(
        constrained.launch({ executable: outside, args: [], environment: {} })
      ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
      await expect(
        constrained.launch({ executable: script, args: [], cwd: '/' })
      ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
      await expect(
        constrained.launch({
          executable: script,
          args: ['a', 'b', 'c', 'd'],
          environment: {},
        })
      ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
    } finally {
      await rm(script, { force: true })
      await rm(outside, { force: true })
    }
  })

  test('rejects invalid policy bounds at construction', () => {
    const codeOf = (policy) => {
      try {
        provider(policy)
        return 'no-error'
      } catch (error) {
        return error.code ?? error.message
      }
    }
    expect(codeOf({ maximumArguments: 0 })).toBe('PROCESS_LAUNCH_INVALID')
    expect(codeOf({ maximumArgumentLength: -1 })).toBe('PROCESS_LAUNCH_INVALID')
    expect(codeOf({ maximumEnvironmentVariables: 0.5 })).toBe('PROCESS_LAUNCH_INVALID')
  })

  test('an executable replaced by a symlink escapes the allowlist denial', async () => {
    const real = join(tmpdir(), `m11-real-${Date.now()}.sh`)
    const link = `${real}.link`
    await writeFile(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await symlink(real, link)
    try {
      const constrained = provider({ allowedExecutables: [real] })
      await constrained.launch({ executable: link, args: [] })
    } finally {
      await rm(real, { force: true })
      await rm(link, { force: true })
    }
  })
})

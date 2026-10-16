import { readFile, rename, writeFile } from 'node:fs/promises'
import { bindRetainedProfileWorkflowWake, ProfileAdapterError } from './index.ts'

const [statePath, mode] = process.argv.slice(2)

async function readState() {
  return JSON.parse(await readFile(statePath, 'utf8'))
}

async function writeState(state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 })
  await rename(temporaryPath, statePath)
}

const driver = {
  deploymentProfile: 'hosted-server',
  kind: 'restate-ingress',
  async submit(input) {
    const state = await readState()
    state.submissions += 1
    if (!state.acceptedExecutionIds.includes(input.executionId)) {
      state.acceptedExecutionIds.push(input.executionId)
    }
    await writeState(state)
    if (mode === 'crash-after-effect') {
      process.stdout.write('EFFECT_RECORDED\n')
      await new Promise(() => undefined)
    }
  },
}

const retainedRecords = {
  commands: {
    getByExecutionId: async () => (await readState()).command,
    getExecution: async () => (await readState()).execution,
  },
  executions: { getAttempt: async () => undefined },
  plans: { get: async () => (await readState()).plan },
}

const wake = await bindRetainedProfileWorkflowWake({
  profile: 'self-hosted',
  deployment: {
    profile: 'hosted-server',
    persistence: { profile: 'hosted-server', dialect: 'postgresql' },
    workflow: { profile: 'hosted-server' },
  },
  driver,
  placement: {
    controlPlaneHostId: 'host:test',
    runtimeHostId: 'host:test',
    runtimeLocation: 'remote_host',
    coLocated: true,
  },
  guards: {
    authority: {
      assertCurrent: async () => {
        if (!(await readState()).actorGrant) {
          throw new ProfileAdapterError('PROFILE_AUTHORITY_REJECTED')
        }
      },
    },
    residency: {
      assertCurrent: async () => {
        if (!(await readState()).resident) {
          throw new ProfileAdapterError('PROFILE_RESIDENCY_REJECTED')
        }
      },
    },
  },
  topology: {
    assertCurrent: async (_context, candidate) => {
      if (candidate !== driver) throw new ProfileAdapterError('PROFILE_WAKE_MISMATCH')
    },
  },
  retainedRecords,
})

if (mode === 'bind-only') {
  process.stdout.write('BOUND\n')
  await new Promise(() => undefined)
} else {
  try {
    await wake.submit((await readState()).workflow)
    process.stdout.write('SUBMITTED\n')
  } catch (error) {
    if (error instanceof ProfileAdapterError && error.code === 'PROFILE_AUTHORITY_REJECTED') {
      process.stdout.write('DENIED\n')
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : 'WAKE_FAILED'}\n`)
      process.exitCode = 1
    }
  }
}

import { expect, test } from 'bun:test'

async function run(
  argv,
  operation = async () => ({ state: 'paused', complete: true, canResume: true })
) {
  const cli = await import('../../../scripts/admission-rollout-admin.mjs')
  const calls = []
  let out = ''
  let err = ''
  const exitCode = await cli.admissionRolloutAdmin({
    argv,
    environment: {
      DATABASE_MIGRATION_URL: 'postgresql://migrator:local-only@database:5432/control_plane',
    },
    openService: async (credentials) => {
      calls.push(['open', credentials.role])
      return {
        service: Object.fromEntries(
          ['getStatus', 'audit', 'pause', 'resume'].map((verb) => [
            verb,
            async () => {
              calls.push([verb])
              return operation()
            },
          ])
        ),
        close: async () => calls.push(['close']),
      }
    },
    writeOut: (text) => (out += text),
    writeErr: (text) => (err += text),
  })
  return { exitCode, calls, out, err }
}

const target = ['--host', 'database', '--port', '5432', '--database', 'control_plane']

test('rollout CLI uses migration credentials and closes each successful operation', async () => {
  for (const verb of ['status', 'audit', 'pause', 'resume']) {
    const confirmation = ['pause', 'resume'].includes(verb) ? ['--confirm', verb] : []
    const result = await run([verb, ...target, ...confirmation])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([
      ['open', 'migration'],
      [verb === 'status' ? 'getStatus' : verb],
      ['close'],
    ])
    expect(JSON.parse(result.out)).toEqual({ state: 'paused', complete: true, canResume: true })
    expect(result.err).toBe('')
  }
})

test('rollout CLI rejects malformed targets, force flags and missing mutation confirmation before connecting', async () => {
  for (const argv of [
    ['pause', ...target],
    ['resume', ...target, '--confirm', 'pause'],
    ['resume', ...target, '--confirm', 'resume', '--force'],
    ['status', ...target, '--host', 'wrong'],
    ['status', '--host', 'wrong', '--port', '5432', '--database', 'control_plane'],
    ['status', '--host', 'database', '--port', '5433', '--database', 'control_plane'],
    ['status', ...target, '--confirm', 'status'],
    ['status', 'resume', ...target],
  ]) {
    const result = await run(argv)
    expect(result.exitCode).toBe(1)
    expect(result.calls).toEqual([])
    expect(result.out).toBe('')
    expect(result.err).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')
  }
})

test('rollout CLI returns nonzero for an incomplete or unsafe audit', async () => {
  for (const report of [
    { complete: false, canResume: false },
    { complete: true, canResume: false },
  ]) {
    const result = await run(['audit', ...target], async () => report)
    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.out)).toEqual(report)
    expect(result.calls.at(-1)).toEqual(['close'])
  }
})

test('rollout CLI sanitizes service failures and always closes', async () => {
  const result = await run(['resume', ...target, '--confirm', 'resume'], async () => {
    throw new Error('postgresql://operator:top-secret@database/control_plane')
  })
  expect(result.exitCode).toBe(1)
  expect(result.out).toBe('')
  expect(result.err).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')
  expect(result.calls.at(-1)).toEqual(['close'])
})

test('rollout CLI never substitutes application or admin URLs for a missing migration URL', async () => {
  const { admissionRolloutAdmin } = await import('../../../scripts/admission-rollout-admin.mjs')
  let opened = false
  let err = ''
  const result = await admissionRolloutAdmin({
    argv: ['status', ...target],
    environment: {
      DATABASE_URL: 'postgresql://app:top-secret@database/control_plane',
      DATABASE_ADMIN_URL: 'postgresql://admin:top-secret@database/control_plane',
    },
    openService: async () => {
      opened = true
      throw new Error('Unexpected connection')
    },
    writeErr: (text) => (err += text),
  })
  expect(result).toBe(1)
  expect(opened).toBe(false)
  expect(err).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')
})

test('rollout CLI treats close failure as a failure without exposing its cause', async () => {
  const { admissionRolloutAdmin } = await import('../../../scripts/admission-rollout-admin.mjs')
  let err = ''
  const result = await admissionRolloutAdmin({
    argv: ['status', ...target],
    environment: {
      DATABASE_MIGRATION_URL: 'postgresql://migrator:local-only@database/control_plane',
    },
    openService: async () => ({
      service: { getStatus: async () => ({ state: 'paused' }) },
      close: async () => {
        throw new Error('top-secret')
      },
    }),
    writeOut: () => {},
    writeErr: (text) => (err += text),
  })
  expect(result).toBe(1)
  expect(err).toBe('ADMISSION_ROLLOUT_ADMIN_CLOSE_FAILED\n')
})

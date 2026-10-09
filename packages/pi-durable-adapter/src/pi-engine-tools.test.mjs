import { test, expect } from 'bun:test'
import { PiDurableEngineToolBlockedError } from './pi-engine.ts'
import { readFile } from 'node:fs/promises'
import { createNativeEngineToolFixture as fixture } from './pi-engine-tools.loopback.fixture.mjs'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const run = {
  sessionId: 'fixture:session',
  requestId: 'fixture:turn',
  input: 'Delegate the bounded objective.',
}
const succeeded = {
  schemaVersion: 'pi-delegate-child-outcome/v1',
  state: 'succeeded',
  toolCallId: id('tlc'),
  delegationId: id('dlg'),
  childExecutionId: id('exe'),
  childAttemptId: id('att'),
}

test('actual Pi SQLite and loopback HTTP register only governed delegate_child and retain all generation receipts', async () => {
  const setup = await fixture()
  try {
    const engine = setup.open()
    const result = await engine.run(run)
    expect(result.text).toBe('Child delegation receipt received.')
    expect(setup.effects()).toBe(1)
    expect(setup.requests).toHaveLength(2)
    expect(setup.requests[0].tools.map((tool) => tool.function.name)).toEqual(['delegate_child'])
    expect(setup.requests[0].tools[0].function.parameters.additionalProperties).toBe(false)
    expect(Object.keys(setup.requests[0].tools[0].function.parameters.properties)).toEqual([
      'objective',
    ])
    expect(result.inferences).toHaveLength(2)
    expect(result.inferences.map((inference) => inference.inferenceId)).toEqual(setup.receipts)
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(6)
    expect(setup.sources[0].sourceKey).toMatch(/^pi-tool:[a-f0-9]{64}$/)
    await engine.close()
    const reopened = setup.open()
    expect(await reopened.run(run)).toMatchObject({
      submissionId: result.submissionId,
      inferences: result.inferences,
    })
    expect(setup.effects()).toBe(1)
    expect(setup.requests).toHaveLength(2)
    await reopened.close()
    expect((await readFile(engine.storePath(run.sessionId))).toString()).not.toContain(
      'fixture-no-paid-account'
    )
  } finally {
    await setup.close()
  }
})

test.each(['awaiting_approval', 'reconciliation_required'])(
  'native %s closes without terminal tool outcome and resumes same execute/safe task after store reopen',
  async (state) => {
    let authorized = false
    const setup = await fixture({
      execute: (_input, effect) => {
        if (!authorized)
          return {
            schemaVersion: 'pi-delegate-child-outcome/v1',
            state,
            toolCallId: id('tlc'),
            ...(state === 'awaiting_approval'
              ? { interactionId: id('int'), reasonCode: 'PI_CHILD_APPROVAL_PENDING' }
              : { reasonCode: 'PI_CHILD_OUTCOME_UNKNOWN' }),
          }
        effect()
        return succeeded
      },
    })
    try {
      const engine = setup.open()
      let blocked
      try {
        await engine.run(run)
      } catch (error) {
        blocked = error
      }
      expect(blocked).toBeInstanceOf(PiDurableEngineToolBlockedError)
      expect(blocked.outcome.state).toBe(state)
      expect(blocked.inferences).toHaveLength(1)
      expect(setup.effects()).toBe(0)
      expect(setup.requests).toHaveLength(1)
      await engine.close()
      const reopened = setup.open()
      const inspection = await reopened.inspect(run.sessionId)
      const task = inspection.tasks.find((candidate) => candidate.record.kind === 'pi.tool')
      expect(task.record.abortRequested).toBe(false)
      expect(task.record.state).toMatchObject({
        status: 'pending',
        checkpoint: { phase: 'execute', replay: 'safe' },
      })
      expect(String(task.record.id)).toBe(blocked.source.taskId)
      expect(inspection.submissions[0].status).toBe('placed')
      authorized = true
      const result = await reopened.run(run)
      expect(result.text).toBe('Child delegation receipt received.')
      expect(setup.sources).toHaveLength(2)
      expect(setup.sources[1]).toEqual(setup.sources[0])
      expect(setup.effects()).toBe(1)
      expect(setup.requests).toHaveLength(2)
      expect(result.inferences[0]).toEqual(blocked.inferences[0])
    } finally {
      await setup.close()
    }
  }
)

test.each([
  { enabled: false },
  { callName: 'bash' },
  { argumentsInput: { objective: 'Valid objective', parentExecutionId: id('exe') } },
  { argumentsInput: { objective: '   ' } },
  { argumentsInput: { objective: 'x'.repeat(8193) } },
])(
  'unconfigured tools, foreign native tools and invalid arguments stay unavailable',
  async (fault) => {
    const setup = await fixture(fault)
    try {
      await expect(setup.open().run(run)).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
      expect(setup.effects()).toBe(0)
      expect(setup.sources).toHaveLength(0)
      expect(setup.requests).toHaveLength(1)
    } finally {
      await setup.close()
    }
  }
)

test('actual process exit and restart retain native tool source and approval checkpoint without replaying inference or settled effect', async () => {
  const setup = await fixture()
  try {
    const fixturePath = new URL('./pi-engine-tools.fixture.mjs', import.meta.url).pathname
    const node = process.env.CONTROL_PLANE_TEST_NODE ?? 'node'
    async function worker(mode) {
      const child = Bun.spawn(
        [
          node,
          '--experimental-strip-types',
          fixturePath,
          setup.options.directory,
          setup.baseUrl,
          mode,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(code, stderr).toBe(0)
        return JSON.parse(stdout.trim())
      } finally {
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
    }
    const initial = await worker('pending')
    expect(initial.blocked.outcome.state).toBe('awaiting_approval')
    expect(initial.effects).toBe('')
    expect(setup.requests).toHaveLength(1)
    const restarted = await worker('resume')
    expect(restarted.pendingTask.abortRequested).toBe(false)
    expect(restarted.pendingTask.state).toMatchObject({
      status: 'pending',
      checkpoint: { phase: 'execute', replay: 'safe' },
    })
    expect(String(restarted.pendingTask.id)).toBe(initial.blocked.source.taskId)
    expect(restarted.sources[0]).toEqual(initial.sources[0])
    expect(restarted.result.inferences[0]).toEqual(initial.blocked.inferences[0])
    expect(restarted.result.inferences).toHaveLength(2)
    expect(restarted.reservations).toHaveLength(1)
    expect(setup.requests).toHaveLength(2)
    expect(restarted.effects.trim().split('\n')).toEqual([initial.blocked.sourceKey])
    const duplicate = await worker('duplicate')
    expect(duplicate.sources).toEqual([])
    expect(duplicate.reservations).toEqual([])
    expect(duplicate.effects).toBe(restarted.effects)
    expect(duplicate.result).toMatchObject({
      submissionId: restarted.result.submissionId,
      inferences: restarted.result.inferences,
    })
    expect(setup.requests).toHaveLength(2)
  } finally {
    await setup.close()
  }
}, 15000)

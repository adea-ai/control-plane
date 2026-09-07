import { describe, expect, test } from 'bun:test'
import { execPath } from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NodeProcessRuntimeProvider } from './process-runtime.ts'

describe('NodeProcessRuntimeProvider', () => {
  test('does not keep the launcher alive after a child stops promptly', async () => {
    const source = new URL('./process-runtime.ts', import.meta.url).href
    const { stdout } = await promisify(execFile)(
      execPath,
      [
        '-e',
        `
      import { NodeProcessRuntimeProvider } from ${JSON.stringify(source)};
      const handle = await new NodeProcessRuntimeProvider({ stopTimeoutMs: 10000 }).launch({
        executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)']
      });
      await handle.stop();
      console.log('stopped');
    `,
      ],
      { timeout: 2000 }
    )
    expect(stdout.trim()).toBe('stopped')
  })

  test('launches without a shell and stops only the owned child', async () => {
    const provider = new NodeProcessRuntimeProvider({ stopTimeoutMs: 2_000 })
    const handle = await provider.launch({
      executable: execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      environment: { CONTROL_PLANE_PROCESS_TEST: 'true' },
    })
    expect(handle.pid).toBeGreaterThan(0)
    await handle.stop()
    expect(await handle.wait()).toBeGreaterThanOrEqual(0)
  })

  test('rejects malformed launch arguments before spawning', async () => {
    const provider = new NodeProcessRuntimeProvider()
    await expect(provider.launch({ executable: '', args: [] })).rejects.toMatchObject({
      code: 'PROCESS_LAUNCH_INVALID',
    })
  })

  test('retains the stop deadline when the child does not exit', async () => {
    const provider = new NodeProcessRuntimeProvider({ stopTimeoutMs: 200 })
    const handle = await provider.launch({
      executable: execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })
    try {
      // A suspended owned child cannot satisfy the graceful-stop wait.
      await expect(handle.stop('SIGSTOP')).rejects.toMatchObject({
        code: 'PROCESS_STOP_TIMEOUT',
      })
    } finally {
      await handle.stop('SIGKILL')
      await handle.wait()
    }
  })
})

import { spawn } from 'node:child_process'

/** Commands own their process group; bounded output and deadlines survive failures. */
export function createPinnedBuildCommand(environment, timeoutMs = 600000) {
  return (command, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: environment,
        stdio: ['ignore', 'pipe', 'inherit'],
        detached: true,
      })
      let stopped = false
      const stop = () => {
        stopped = true
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') reject(error)
        }
      }
      const timer = setTimeout(stop, timeoutMs)
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
        if (code === 0 && !stopped) resolve(output.trim())
        else reject(new Error(`PINNED_BUILD_COMMAND_FAILED:${command}:${code}`))
      })
    })
}

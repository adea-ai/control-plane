import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  fsyncSync,
} from 'node:fs'
import { join } from 'node:path'

/** Single-host process ownership, supplementing journal epochs before opening Pi SQLite. */
export class NodeSessionLease {
  readonly #path: string
  readonly #identity = randomUUID()
  #released = false

  constructor(directory: string, sessionId: string) {
    mkdirSync(directory, { recursive: true })
    this.#path = join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.owner`)
    try {
      this.#create()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = JSON.parse(readFileSync(this.#path, 'utf8')) as { pid: number }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
        throw new Error('PI_SESSION_OWNER_INVALID', { cause: error })
      try {
        process.kill(previous.pid, 0)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          unlinkSync(this.#path)
          this.#create()
          return
        }
        throw new Error('PI_SESSION_OWNER_ACTIVE', { cause: probe })
      }
      // PID reuse also fails closed; an operator must reconcile that stale lease.
      throw new Error('PI_SESSION_OWNER_ACTIVE', { cause: error })
    }
  }

  #create(): void {
    const descriptor = openSync(this.#path, 'wx', 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity: this.#identity }))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  release(): void {
    if (this.#released) return
    this.#released = true
    const current = JSON.parse(readFileSync(this.#path, 'utf8')) as { identity: string }
    if (current.identity === this.#identity) unlinkSync(this.#path)
  }
}

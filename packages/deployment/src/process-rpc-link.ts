import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'

/**
 * Why the caller keeps the spawn: executable identity, spawn policy enforcement
 * (CP-RNODE-025) and platform-specific spawn flags (e.g. `detached` for
 * process-group signalling) stay at the call site. This primitive only takes the
 * already-spawned child and owns the RPC plumbing on top of its pipes.
 */
export type ProcessRpcSignalStrategy = 'process-group' | 'child'

/** Settle reasons reported through `ProcessRpcRequestOptions.onSettled`. */
export type ProcessRpcSettleReason = 'response' | 'timeout' | 'abort' | 'failure'

export interface ProcessRpcExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/**
 * Thrown by a frame codec when a line cannot be decoded. `fatal: true`
 * (default) permanently fails the link and sends the protocol-failure signal;
 * `fatal: false` only rejects the outstanding requests and keeps reading, for
 * runtimes that tolerate stray garbage on stdout.
 */
export class ProcessRpcDecodeError extends Error {
  readonly fatal: boolean

  constructor(message: string, fatal = true) {
    super(message)
    this.name = 'ProcessRpcDecodeError'
    this.fatal = fatal
  }
}

/** A decoded line that settles (or rejects) the pending request with `id`. */
export interface ProcessRpcResponseFrame<Result> {
  readonly kind: 'response'
  readonly id: string | number
  /** Resolved value; codecs must coerce absent results (e.g. to `null`). */
  readonly result?: Result | undefined
  /** When set, the pending request rejects with this error. */
  readonly error?: Error | undefined
}

/** A decoded line that is not a response; forwarded to the `onLine` hook. */
export interface ProcessRpcUnmatchedFrame<Message> {
  readonly kind: 'unmatched'
  readonly message: Message
}

/**
 * Codec output for one complete line. Return `null` to ignore the line
 * entirely (e.g. non-object payloads on runtimes that emit them).
 */
export type ProcessRpcDecodedFrame<Result, Message> =
  | ProcessRpcResponseFrame<Result>
  | ProcessRpcUnmatchedFrame<Message>
  | null

/**
 * Protocol adapter owned by the caller: `encode` renders one outbound frame
 * (without the trailing newline, which the link appends) and `decode` parses
 * one complete inbound line. Codec throws become link failures exactly as
 * thrown, so protocol error identity stays with the protocol owner.
 */
export interface ProcessRpcFrameCodec<Request, Result, Message> {
  encode(request: Request, id: string | number | undefined): string
  decode(line: string): ProcessRpcDecodedFrame<Result, Message>
}

export interface ProcessRpcRequestOptions {
  /** Correlation id; the caller owns id formatting and monotonicity. */
  readonly id: string | number
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  /** Called exactly once when the pending entry leaves the map. */
  readonly onSettled?: ((reason: ProcessRpcSettleReason) => void) | undefined
}

export interface ProcessRpcStopOptions {
  /** Fail all pending requests with this error before signalling (graceful shutdown). */
  readonly failure?: Error | undefined
  /** Milliseconds to wait for exit after SIGTERM. Default 2_000. */
  readonly graceMs?: number | undefined
  /**
   * Milliseconds to wait for exit after SIGKILL. Default 2_000; `0` resolves
   * immediately after sending SIGKILL without confirming the exit.
   */
  readonly finalWaitMs?: number | undefined
}

/** Response frame for an id with no pending request (e.g. a late result). */
export interface ProcessRpcMissedResponse<Result> {
  readonly result?: Result | undefined
  readonly error?: Error | undefined
}

export interface ProcessRpcLinkOptions<Request, Result, Message> {
  readonly child: ChildProcessWithoutNullStreams
  readonly codec: ProcessRpcFrameCodec<Request, Result, Message>
  /** Inbound byte cap, enforced per complete line and on the unterminated residual. */
  readonly maxFrameBytes: number
  /** Error surfaced when a frame exceeds `maxFrameBytes` or is not valid UTF-8 under `strictUtf8`. */
  readonly formatFrameError: () => Error
  readonly formatExitError: (info: ProcessRpcExitInfo) => Error
  readonly formatTimeoutError: (request: Request) => Error
  /** Rejects requests when the child is gone and no failure is recorded. */
  readonly notRunningError: () => Error
  /** Rejects requests aborted through `signal`; omit to disable abort support. */
  readonly formatAbortError?: (() => Error) | undefined
  /** Maps raw child `error` events (e.g. spawn failures); defaults to the raw error. */
  readonly formatChildError?: ((error: Error) => Error) | undefined
  /** Delivers responses for ids with no pending request (late-result delivery). */
  readonly onResponseMiss?:
    | ((id: string | number, response: ProcessRpcMissedResponse<Result>) => void)
    | undefined
  /** Always wired so stdin `error` events cannot crash the process; acp escalates to a failure. */
  readonly onStdinError?: ((error: Error) => void) | undefined
  /** Receives every decoded line that is not a pending-response match. */
  readonly onLine?: ((message: Message) => void) | undefined
  /** Fired once when the child ends (exit/close) or fails fatally. */
  readonly onExit?: ((error: Error) => void) | undefined
  /** Fired on the first permanent failure, before pending rejections are observed. */
  readonly onFail?: ((error: Error) => void) | undefined
  /** `process-group` signals `-pid` (ESRCH-tolerant, deduplicated); `child` signals the child only. */
  readonly signalStrategy?: ProcessRpcSignalStrategy | undefined
  /** Signal sent when framing or decoding fails fatally. Default `SIGTERM`. */
  readonly protocolFailureSignal?: NodeJS.Signals | undefined
  /** Strip one trailing `\r` per line before the byte-cap check. Default `false`. */
  readonly stripCarriageReturn?: boolean | undefined
  /** Ignore empty lines instead of failing them through the codec. Default `false`. */
  readonly skipEmptyLines?: boolean | undefined
  /** Fail on invalid UTF-8 instead of replacing ill-formed sequences. Default `true`. */
  readonly strictUtf8?: boolean | undefined
  /**
   * When true (default) exit/close and child errors record a permanent failure;
   * when false they only sweep pending requests, and later requests reject
   * with `notRunningError()` until the child is detached by `stop()`.
   */
  readonly exitIsPermanentFailure?: boolean | undefined
  /** Outbound byte cap checked against the encoded frame and the stdin buffer; omit for no cap. */
  readonly writeLimitBytes?: number | undefined
  /** Settle the pending request with the raw `stdin.write` callback error instead of relying on stdin `error`. */
  readonly writeFailureRejectsPending?: boolean | undefined
  /** Unref the stop-ladder wait timers so they cannot hold the event loop. Default `true`. */
  readonly unrefStopTimers?: boolean | undefined
}

interface ProcessRpcActiveRequest<Request, Result> {
  readonly payload: Request
  resolve(value: Result): void
  reject(error: Error, reason: ProcessRpcSettleReason): void
}

const defaultStopGraceMs = 2_000
const defaultStopFinalWaitMs = 2_000

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Newline-framed request/response plumbing over an already-spawned child
 * process: bounded framing with byte caps, a pending-request map with unref'd
 * timeouts, the SIGTERM -> SIGKILL stop ladder, and a fail-all sweep on exit,
 * write failure, or fatal protocol error. Protocol shape and error identity
 * stay with the caller through the frame codec and error formatters.
 */
export class ProcessRpcLink<Request, Result, Message> {
  readonly #options: ProcessRpcLinkOptions<Request, Result, Message>
  readonly #codec: ProcessRpcFrameCodec<Request, Result, Message>
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<string | number, ProcessRpcActiveRequest<Request, Result>>()
  readonly #ended: Promise<void>
  #endedResolve: (() => void) | undefined
  #buffer = Buffer.alloc(0)
  #failure: Error | undefined
  #detached = false
  #endedHandled = false
  #lastSignal: NodeJS.Signals | undefined
  #stopPromise: Promise<boolean> | undefined

  constructor(options: ProcessRpcLinkOptions<Request, Result, Message>) {
    this.#options = options
    this.#codec = options.codec
    this.#child = options.child
    this.#ended = new Promise<void>((resolve) => {
      this.#endedResolve = resolve
    })
    const child = options.child
    child.stdout.on('data', (chunk: Buffer) => this.#read(chunk))
    child.stderr.resume()
    // Wired unconditionally so a failed write can never surface as an
    // unhandled 'error' event; callers escalate through the hook if wanted.
    child.stdin.on('error', (error: Error) => options.onStdinError?.(error))
    child.once('error', (error: Error) => {
      const mapped = options.formatChildError?.(error) ?? error
      if (this.#permanentFailures()) this.#fail(mapped)
      else {
        this.#sweep(mapped)
        options.onExit?.(mapped)
      }
    })
    child.once('exit', (code, signal) => this.#handleEnd(code, signal))
    child.once('close', (code, signal) => this.#handleEnd(code, signal))
  }

  /** True while the child is attached and no failure has been recorded. */
  get connected(): boolean {
    return !this.#detached && !this.#endedHandled && this.#failure === undefined
  }

  /** First permanent failure recorded for this link, if any. */
  get failure(): Error | undefined {
    return this.#failure
  }

  /** Outstanding pending requests; callers enforce their own pending limits. */
  get pendingCount(): number {
    return this.#pending.size
  }

  /**
   * Sends `payload` and correlates the response by `options.id`. The timeout
   * timer is unref'd; write and encoding failures reject the request without
   * failing the link.
   */
  request(payload: Request, options: ProcessRpcRequestOptions): Promise<Result> {
    const { id, timeoutMs, signal, onSettled } = options
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error('PROCESS_RPC_INVALID_TIMEOUT'))
    }
    const failure = this.#failure
    if (failure !== undefined || this.#detached || this.#endedHandled) {
      return Promise.reject(failure ?? this.#options.notRunningError())
    }
    if (signal?.aborted === true) return Promise.reject(this.#abortError())
    return new Promise<Result>((resolve, reject) => {
      const finish = (settle: () => void, reason: ProcessRpcSettleReason) => {
        if (!this.#pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        onSettled?.(reason)
        settle()
      }
      const aborted = () => finish(() => reject(this.#abortError()), 'abort')
      const timer = setTimeout(
        () => finish(() => reject(this.#options.formatTimeoutError(payload)), 'timeout'),
        timeoutMs
      )
      timer.unref()
      const entry: ProcessRpcActiveRequest<Request, Result> = {
        payload,
        resolve: (value) => finish(() => resolve(value), 'response'),
        reject: (error, reason) => finish(() => reject(error), reason),
      }
      this.#pending.set(id, entry)
      signal?.addEventListener('abort', aborted, { once: true })
      try {
        this.#write(payload, id)
      } catch (error) {
        entry.reject(asError(error), 'response')
      }
    })
  }

  /**
   * Writes one outbound frame without registering a pending request (notify /
   * respond style). Throws on disconnected links, encode failures, and
   * outbound limit violations.
   */
  write(payload: Request): void {
    this.#write(payload, undefined)
  }

  /** Records a permanent failure and sweeps pending requests (caller-invoked). */
  fail(error: Error): void {
    this.#fail(error)
  }

  /**
   * SIGTERM -> grace -> SIGKILL stop ladder. Returns whether the exit was
   * confirmed within the waits; memoized, and resolves immediately when the
   * child already ended.
   */
  stop(options: ProcessRpcStopOptions = {}): Promise<boolean> {
    this.#stopPromise ??= this.#stopProcess(options)
    return this.#stopPromise
  }

  async #stopProcess(options: ProcessRpcStopOptions): Promise<boolean> {
    const { failure, graceMs = defaultStopGraceMs, finalWaitMs = defaultStopFinalWaitMs } = options
    if (failure !== undefined) this.#fail(failure)
    if (this.#detached || this.#endedHandled) return true
    if (!this.#permanentFailures()) this.#detach()
    this.#sendSignal('SIGTERM')
    if (await this.#waitEnded(graceMs)) return true
    this.#sendSignal('SIGKILL')
    if (finalWaitMs <= 0) return false
    return this.#waitEnded(finalWaitMs)
  }

  #abortError(): Error {
    const format = this.#options.formatAbortError
    if (format === undefined) throw new Error('PROCESS_RPC_ABORT_UNSUPPORTED')
    return format()
  }

  #permanentFailures(): boolean {
    return this.#options.exitIsPermanentFailure ?? true
  }

  #write(payload: Request, id: string | number | undefined): void {
    const failure = this.#failure
    if (failure !== undefined) throw failure
    if (this.#detached || this.#endedHandled) throw this.#options.notRunningError()
    const encoded = `${this.#codec.encode(payload, id)}\n`
    const writeLimit = this.#options.writeLimitBytes
    if (writeLimit !== undefined) {
      if (Buffer.byteLength(encoded) > writeLimit) {
        throw new Error('PROCESS_RPC_MESSAGE_TOO_LARGE')
      }
      if (this.#child.stdin.writableLength + Buffer.byteLength(encoded) > writeLimit) {
        throw new Error('PROCESS_RPC_BACKPRESSURE')
      }
    }
    if (this.#options.writeFailureRejectsPending === true && id !== undefined) {
      const entry = this.#pending.get(id)
      this.#child.stdin.write(encoded, (error) => {
        if (error === null || error === undefined || entry === undefined || !this.#pending.has(id))
          return
        entry.reject(error, 'response')
      })
      return
    }
    this.#child.stdin.write(encoded)
  }

  #read(chunk: Buffer): void {
    if (this.#failure !== undefined) return
    let start = 0
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      this.#consumeLine(chunk.subarray(start, end))
      if (this.#failure !== undefined) return
      start = end + 1
    }
    const residual = chunk.subarray(start)
    if (
      residual.length > 0 &&
      this.#buffer.length + residual.length > this.#options.maxFrameBytes
    ) {
      this.#failFatal(this.#options.formatFrameError())
    } else if (residual.length > 0) {
      this.#buffer = Buffer.concat([this.#buffer, residual])
    }
  }

  #consumeLine(lineBytes: Buffer): void {
    const stripCarriageReturn = this.#options.stripCarriageReturn === true
    const line =
      stripCarriageReturn && lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 13
        ? lineBytes.subarray(0, lineBytes.length - 1)
        : lineBytes
    if (this.#buffer.length + line.length > this.#options.maxFrameBytes) {
      this.#failFatal(this.#options.formatFrameError())
      return
    }
    const full = this.#buffer.length === 0 ? line : Buffer.concat([this.#buffer, line])
    this.#buffer = Buffer.alloc(0)
    if (full.length === 0) {
      if (this.#options.skipEmptyLines === true) return
      // An empty frame is protocol garbage; hand it to the codec so the
      // protocol owner decides (strict codecs reject it, lenient ones skip).
      this.#dispatch('')
      return
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: this.#options.strictUtf8 !== false }).decode(full)
    } catch {
      this.#failFatal(this.#options.formatFrameError())
      return
    }
    this.#dispatch(text)
  }

  #dispatch(line: string): void {
    let decoded: ProcessRpcDecodedFrame<Result, Message>
    try {
      decoded = this.#codec.decode(line)
    } catch (error) {
      if (error instanceof ProcessRpcDecodeError && !error.fatal) {
        // Tolerable garbage: reject outstanding requests, keep reading.
        this.#sweep(error)
        return
      }
      this.#failFatal(asError(error))
      return
    }
    if (decoded === null) return
    if (decoded.kind === 'unmatched') {
      try {
        this.#options.onLine?.(decoded.message)
      } catch (error) {
        this.#failFatal(asError(error))
      }
      return
    }
    const entry = this.#pending.get(decoded.id)
    if (entry === undefined) {
      const onResponseMiss = this.#options.onResponseMiss
      if (onResponseMiss !== undefined) {
        try {
          onResponseMiss(decoded.id, { result: decoded.result, error: decoded.error })
        } catch (error) {
          this.#failFatal(asError(error))
        }
      }
      return
    }
    const { error, result } = decoded
    if (error !== undefined) entry.reject(error, 'response')
    else entry.resolve(result as Result)
  }

  #handleEnd(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#endedHandled) return
    this.#endedHandled = true
    const error = this.#options.formatExitError({ code, signal })
    if (this.#permanentFailures()) {
      this.#fail(error)
      this.#detach()
    } else {
      this.#detach()
      this.#sweep(error)
    }
    this.#options.onExit?.(error)
    this.#endedResolve?.()
  }

  #failFatal(error: Error): void {
    const first = this.#failure === undefined
    this.#fail(error)
    if (first) this.#options.onExit?.(error)
    this.#sendSignal(this.#options.protocolFailureSignal ?? 'SIGTERM')
  }

  #fail(error: Error): void {
    if (this.#failure === undefined) {
      this.#failure = error
      this.#buffer = Buffer.alloc(0)
      this.#options.onFail?.(error)
    }
    this.#sweep(this.#failure as Error)
  }

  #sweep(error: Error): void {
    for (const entry of this.#pending.values()) entry.reject(error, 'failure')
    this.#pending.clear()
  }

  #detach(): void {
    this.#detached = true
  }

  #sendSignal(signal: NodeJS.Signals): void {
    if (this.#lastSignal === signal) return
    try {
      if (this.#options.signalStrategy === 'child') {
        this.#child.kill(signal)
      } else {
        const pid = this.#child.pid
        if (pid === undefined) return
        if (process.platform === 'win32') this.#child.kill(signal)
        else process.kill(-pid, signal)
      }
      this.#lastSignal = signal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  async #waitEnded(timeoutMs: number): Promise<boolean> {
    if (this.#endedHandled) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#ended.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
          if (this.#options.unrefStopTimers !== false) timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

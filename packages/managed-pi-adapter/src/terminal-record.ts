import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RuntimeAdapterError,
  RuntimeExecutionHandleSchema,
  type RuntimeExecutionHandle,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  ManagedPiEventSchema,
  ManagedPiStatusSchema,
  type ManagedPiEvent,
  type ManagedPiStatus,
} from './index.js'

const recordSchema = () =>
  z
    .object({
      schemaVersion: z.literal(1),
      handle: RuntimeExecutionHandleSchema,
      events: z.array(ManagedPiEventSchema).max(4096).optional(),
      status: ManagedPiStatusSchema.refine(({ state }) =>
        ['succeeded', 'errored', 'cancelled'].includes(state)
      ),
    })
    .strict()
    .refine(({ events, status }) => {
      if (!events) return true
      const terminal = events.at(-1)
      return (
        events.every((event, index) => event.sequence === index + 1) &&
        terminal?.kind === 'status' &&
        terminal.state === status.state
      )
    })
const MAX_RECORD_BYTES = 8_388_608

export async function persistTerminalRecord(
  dataDirectory: string,
  handle: RuntimeExecutionHandle,
  status: ManagedPiStatus,
  events: readonly ManagedPiEvent[]
): Promise<void> {
  const record = recordSchema().safeParse({ schemaVersion: 1, handle, status, events })
  if (!record.success) throw uncertain()
  const bytes = JSON.stringify(record.data)
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw uncertain()
  const directory = join(dataDirectory, 'terminal-results')
  const temporary = join(directory, `${handle.attemptId}.${randomUUID()}.tmp`)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, join(directory, `${handle.attemptId}.json`))
    for (const path of [directory, dataDirectory]) {
      const parent = await open(path, 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } catch {
    throw uncertain()
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function readTerminalRecord(
  dataDirectory: string,
  input: RuntimeExecutionHandle
): Promise<ManagedPiStatus> {
  return (await readRecord(dataDirectory, input)).status
}

export async function readTerminalEvents(
  dataDirectory: string,
  input: RuntimeExecutionHandle
): Promise<ManagedPiEvent[]> {
  const record = await readRecord(dataDirectory, input)
  if (!record.events) throw uncertain()
  return record.events
}

async function readRecord(dataDirectory: string, input: RuntimeExecutionHandle) {
  const handle = RuntimeExecutionHandleSchema.parse(input)
  const record = await readAttemptRecord(dataDirectory, handle.attemptId)
  if (record.handle.handleId !== handle.handleId || record.handle.startedAt !== handle.startedAt)
    throw uncertain()
  return record
}

export async function recoverTerminalHandle(
  dataDirectory: string,
  attemptId: string,
  commandDigest: string
): Promise<RuntimeExecutionHandle> {
  RuntimeExecutionHandleSchema.shape.attemptId.parse(attemptId)
  const file = await open(
    join(dataDirectory, 'admissions', `${attemptId}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW
  )
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 256) throw uncertain()
    const admission = z
      .object({ schemaVersion: z.literal(1), commandDigest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(JSON.parse(await file.readFile('utf8')))
    if (admission.commandDigest !== commandDigest)
      throw new RuntimeAdapterError({
        code: 'PI_START_IDEMPOTENCY_CONFLICT',
        classification: 'conflict',
        message: 'PI_START_IDEMPOTENCY_CONFLICT',
        retryable: false,
      })
  } finally {
    await file.close()
  }
  return (await readAttemptRecord(dataDirectory, attemptId)).handle
}

async function readAttemptRecord(dataDirectory: string, attemptId: string) {
  try {
    const file = await open(
      join(dataDirectory, 'terminal-results', `${attemptId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) throw uncertain()
      const record = recordSchema().parse(JSON.parse(await file.readFile('utf8')))
      if (
        record.handle.handleId !== `managed-pi:${attemptId}` ||
        record.handle.attemptId !== attemptId
      )
        throw uncertain()
      return record
    } finally {
      await file.close()
    }
  } catch {
    throw uncertain()
  }
}

function uncertain() {
  return new RuntimeAdapterError({
    code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
    classification: 'unknown',
    message: 'Pi terminal outcome requires reconciliation',
    retryable: false,
  })
}

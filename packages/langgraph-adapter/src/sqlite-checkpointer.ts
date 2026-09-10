import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BaseCheckpointSaver, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint'
import type { PersistenceProvider, PersistenceRecord } from '@control-plane/deployment'
import { z } from 'zod'

type Config = Parameters<BaseCheckpointSaver['getTuple']>[0]
type Tuple = NonNullable<Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>>
type ListOptions = Parameters<BaseCheckpointSaver['list']>[1]
const namespace = 'langgraph-checkpoints-v1'
const identifier = z.string().min(1).max(2048)
const blob = z.tuple([z.string().min(1), z.string(), z.string().regex(/^[a-f0-9]{64}$/)])
const rowSchema = z
  .object({
    version: z.literal(1),
    scope: identifier,
    thread: identifier,
    ns: z.string().max(2048),
    checkpointId: identifier,
    kind: z.enum(['checkpoint', 'write']),
    checkpoint: blob.optional(),
    metadata: blob.optional(),
    parent: identifier.optional(),
    task: identifier.optional(),
    index: z.number().int().optional(),
    channel: z.string().optional(),
    value: blob.optional(),
  })
  .strict()
type Row = z.output<typeof rowSchema>

/** Uses the existing SQLite database and its transaction/backup lifecycle; owns no connection. */
export class LangGraphSqliteCheckpointSaver extends BaseCheckpointSaver {
  readonly #persistence: Pick<PersistenceProvider, 'transaction'>
  readonly #scope: string

  constructor(persistence: Pick<PersistenceProvider, 'transaction' | 'dialect'>, scope: string) {
    super()
    if (persistence.dialect !== 'sqlite') throw new Error('GRAPH_SQLITE_PROVIDER_REQUIRED')
    this.#persistence = persistence
    this.#scope = identifier.parse(scope)
  }

  async getTuple(config: Config): Promise<Tuple | undefined> {
    const { thread, ns, checkpointId } = location(config)
    const rows = await this.#rows(thread)
    const checkpoint = rows
      .filter(
        (row) =>
          row.kind === 'checkpoint' &&
          row.ns === ns &&
          (checkpointId === undefined || row.checkpointId === checkpointId)
      )
      .toSorted((a, b) => b.checkpointId.localeCompare(a.checkpointId))[0]
    return checkpoint === undefined ? undefined : this.#tuple(checkpoint, rows)
  }

  async *list(config: Config, options: ListOptions = {}): AsyncGenerator<Tuple> {
    const { thread, checkpointId } = location(config)
    const explicitNs = config.configurable?.['checkpoint_ns']
    const before = options.before?.configurable?.['checkpoint_id']
    let remaining = options.limit ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(remaining) || remaining < 0)
      throw new Error('GRAPH_CHECKPOINT_LIMIT_INVALID')
    const rows = await this.#rows(thread)
    for (const row of rows
      .filter((candidateRow) => candidateRow.kind === 'checkpoint')
      .toSorted((a, b) => b.checkpointId.localeCompare(a.checkpointId))) {
      if (remaining === 0) break
      if (explicitNs !== undefined && row.ns !== explicitNs) continue
      if (checkpointId !== undefined && row.checkpointId !== checkpointId) continue
      if (typeof before === 'string' && row.checkpointId >= before) continue
      const tuple = await this.#tuple(row, rows)
      if (
        options.filter !== undefined &&
        !Object.entries(options.filter).every(([key, value]) =>
          isDeepStrictEqual(
            Object.entries(tuple.metadata ?? {}).find(([entry]) => entry === key)?.[1],
            value
          )
        )
      )
        continue
      remaining--
      yield tuple
    }
  }

  async put(
    config: Config,
    checkpoint: Parameters<BaseCheckpointSaver['put']>[1],
    metadata: Parameters<BaseCheckpointSaver['put']>[2],
    _newVersions: Parameters<BaseCheckpointSaver['put']>[3]
  ): Promise<Config> {
    const { thread, ns, checkpointId: parent } = location(config)
    if (checkpoint.v !== 4) throw new Error('GRAPH_CHECKPOINT_VERSION_UNSUPPORTED')
    const checkpointId = identifier.parse(checkpoint.id)
    if (checkpointId === parent) throw new Error('GRAPH_CHECKPOINT_PARENT_INVALID')
    const row: Row = {
      version: 1,
      scope: this.#scope,
      kind: 'checkpoint',
      thread,
      ns,
      checkpointId,
      checkpoint: await this.#encode(checkpoint),
      metadata: await this.#encode(metadata),
      ...(parent === undefined ? {} : { parent }),
    }
    await this.#persistence.transaction(async (tx) => {
      const id = rowId(row)
      if (parent !== undefined) {
        const parentRecord = await tx.get(namespace, rowId({ ...row, checkpointId: parent }))
        if (parentRecord === undefined) throw new Error('GRAPH_CHECKPOINT_PARENT_MISSING')
        decodeRow(parentRecord)
      }
      const existing = await tx.get(namespace, id)
      if (existing !== undefined) {
        const previous = decodeRow(existing)
        // Serializer output ordering is not checkpoint identity.
        if (
          !isDeepStrictEqual(await this.#decode(previous.checkpoint), checkpoint) ||
          !isDeepStrictEqual(await this.#decode(previous.metadata), metadata) ||
          previous.parent !== parent
        )
          throw new Error('GRAPH_CHECKPOINT_CONFLICT')
        return
      }
      await tx.put({ namespace, id, value: z.json().parse(row) })
    })
    return configuration(thread, ns, checkpointId)
  }

  async putWrites(
    config: Config,
    writes: Parameters<BaseCheckpointSaver['putWrites']>[1],
    taskId: string
  ): Promise<void> {
    const { thread, ns, checkpointId } = location(config)
    if (checkpointId === undefined) throw new Error('GRAPH_CHECKPOINT_ID_REQUIRED')
    const task = identifier.parse(taskId)
    const rows = await Promise.all(
      writes.map(async ([channel, value], index): Promise<Row> => ({
        version: 1,
        scope: this.#scope,
        kind: 'write',
        thread,
        ns,
        checkpointId,
        task,
        index: WRITES_IDX_MAP[channel] ?? index,
        channel,
        value: await this.#encode(value),
      }))
    )
    await this.#persistence.transaction(async (tx) => {
      for (const row of rows) {
        const id = rowId(row)
        const existing = await tx.get(namespace, id)
        if (existing !== undefined && (row.index ?? 0) >= 0) continue
        await tx.put({
          namespace,
          id,
          ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
          value: z.json().parse(row),
        })
      }
    })
  }

  async deleteThread(threadId: string): Promise<void> {
    const thread = identifier.parse(threadId)
    await this.#persistence.transaction(async (tx) => {
      for (const record of await tx.list(namespace)) {
        const row = decodeRow(record)
        if (row.scope === this.#scope && row.thread === thread)
          await tx.delete(namespace, record.id, record.revision)
      }
    })
  }

  async #rows(thread: string): Promise<Row[]> {
    return this.#persistence.transaction(async (tx) =>
      (await tx.list(namespace))
        .map(decodeRow)
        .filter((row) => row.scope === this.#scope && row.thread === thread)
    )
  }

  async #tuple(row: Row, rows: Row[]): Promise<Tuple> {
    const checkpoint = (await this.#decode(row.checkpoint)) as Tuple['checkpoint']
    if (checkpoint?.id !== row.checkpointId || checkpoint.v !== 4)
      throw new Error('GRAPH_CHECKPOINT_CORRUPT')
    const pendingWrites: NonNullable<Tuple['pendingWrites']> = []
    for (const write of rows
      .filter(
        (item) =>
          item.kind === 'write' && item.ns === row.ns && item.checkpointId === row.checkpointId
      )
      .toSorted(
        (a, b) => (a.task ?? '').localeCompare(b.task ?? '') || (a.index ?? 0) - (b.index ?? 0)
      )) {
      if (write.task === undefined || write.channel === undefined)
        throw new Error('GRAPH_CHECKPOINT_CORRUPT')
      pendingWrites.push([write.task, write.channel, await this.#decode(write.value)])
    }
    return {
      config: configuration(row.thread, row.ns, row.checkpointId),
      checkpoint,
      metadata: (await this.#decode(row.metadata)) as NonNullable<Tuple['metadata']>,
      pendingWrites,
      ...(row.parent === undefined
        ? {}
        : { parentConfig: configuration(row.thread, row.ns, row.parent) }),
    }
  }

  async #encode(value: unknown): Promise<[string, string, string]> {
    const [type, bytes] = await this.serde.dumpsTyped(value)
    return [
      type,
      Buffer.from(bytes).toString('base64'),
      createHash('sha256').update(bytes).digest('hex'),
    ]
  }

  async #decode(value: [string, string, string] | undefined): Promise<unknown> {
    if (value === undefined) throw new Error('GRAPH_CHECKPOINT_CORRUPT')
    const bytes = Buffer.from(value[1], 'base64')
    if (bytes.toString('base64') !== value[1]) throw new Error('GRAPH_CHECKPOINT_CORRUPT')
    if (createHash('sha256').update(bytes).digest('hex') !== value[2])
      throw new Error('GRAPH_CHECKPOINT_CORRUPT')
    return this.serde.loadsTyped(value[0], bytes)
  }
}

function location(config: Config) {
  return {
    thread: identifier.parse(config.configurable?.['thread_id']),
    ns: z
      .string()
      .max(2048)
      .parse(config.configurable?.['checkpoint_ns'] ?? ''),
    checkpointId:
      config.configurable?.['checkpoint_id'] === undefined
        ? undefined
        : identifier.parse(config.configurable['checkpoint_id']),
  }
}
function configuration(thread: string, ns: string, checkpointId: string): Config {
  return { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: checkpointId } }
}
function rowId(row: Row): string {
  return `g-${createHash('sha256')
    .update(
      JSON.stringify([
        row.scope,
        row.thread,
        row.ns,
        row.checkpointId,
        row.kind,
        row.task ?? null,
        row.index ?? null,
      ])
    )
    .digest('hex')}`
}
function decodeRow(record: PersistenceRecord): Row {
  const row = rowSchema.parse(record.value)
  if (record.id !== rowId(row)) throw new Error('GRAPH_CHECKPOINT_CORRUPT')
  return row
}

import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const NativeRef = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/|-]*$/)
// Pi1.1 native task/conversation/entry IDs are positive integers. Only those
// identity fields are normalized; source refs remain bounded opaque strings.
const NativeIdentity = z.union([NativeRef, z.number().int().positive().safe().transform(String)])
const Objective = z.strictObject({ objective: z.string().trim().min(1).max(8192) })
/** Bounded management tool arguments verified against the native transcript. */
export const ManagementCallArgumentsSchema = z.strictObject({
  operation: z.string().min(1).max(128),
  input: z.record(z.string(), z.json()),
})

/** Host-only identity read from the retained journal and native Pi store.
 * Parsing this identity never authenticates a caller or admits a tool effect.
 */
export const PiDurableToolSourceSchema = z.strictObject({
  schemaVersion: z.literal('pi-tool-source/v1'),
  workspaceId: IdentifierSchemas.workspaceId,
  parentExecutionId: IdentifierSchemas.executionId,
  parentAttemptId: IdentifierSchemas.attemptId,
  runtimeHandleId: NativeRef,
  externalSessionId: NativeRef,
  admittedTurnKey: NativeRef,
  conversationId: NativeRef,
  taskId: NativeRef,
  assistantEntryId: NativeRef,
  callId: NativeRef,
})
export type PiDurableToolSource = z.output<typeof PiDurableToolSourceSchema>

export function piDurableToolSourceKey(input: unknown): string {
  const source = PiDurableToolSourceSchema.parse(input)
  const tuple = [
    source.schemaVersion,
    source.workspaceId,
    source.parentExecutionId,
    source.parentAttemptId,
    source.runtimeHandleId,
    source.externalSessionId,
    source.admittedTurnKey,
    source.conversationId,
    source.taskId,
    source.assistantEntryId,
    source.callId,
  ]
  return `pi-tool:${createHash('sha256').update(canonicalJsonStringify(tuple)).digest('hex')}`
}

export interface PiDurableToolSourceReader {
  /** Re-read the exact retained turn/attempt and current process fence, scope,
   * actor and policy. No lookup of an inferred latest attempt is permitted.
   */
  assertCurrent(source: PiDurableToolSource): Promise<void>
  /** Read from the source's bound native session store, never model input. */
  readTask(source: PiDurableToolSource): Promise<unknown>
  readAssistantEntry(source: PiDurableToolSource): Promise<unknown>
}

const taskSchema = <Arguments>(argumentsSchema: z.ZodType<Arguments>) =>
  z
    .object({
      id: NativeIdentity,
      conversationId: NativeIdentity,
      kind: z.literal('pi.tool'),
      version: z.literal(1),
      abortRequested: z.literal(false),
      input: z.strictObject({ assistant: NativeIdentity, callId: NativeRef }),
      state: z
        .object({
          status: z.literal('running'),
          checkpoint: z.strictObject({
            phase: z.literal('execute'),
            arguments: argumentsSchema,
            replay: z.literal('safe'),
          }),
        })
        .passthrough(),
    })
    .passthrough()

/**
 * Shared transcript verification for one governed engine tool. The host gate
 * independently checks the full request and originating approval before any
 * effect; this proves the model actually requested the exact arguments.
 */
async function verifyPiDurableToolSourceFor<Arguments>(
  input: unknown,
  expectedInput: unknown,
  reader: PiDurableToolSourceReader,
  config: {
    readonly toolName: string
    readonly schema: z.ZodType<Arguments>
  }
): Promise<{ source: PiDurableToolSource; sourceKey: string; args: Arguments }> {
  try {
    const Task = taskSchema(config.schema)
    const source = PiDurableToolSourceSchema.parse(input)
    const expected = config.schema.parse(expectedInput)
    await reader.assertCurrent(structuredClone(source))
    const task = Task.parse(await reader.readTask(structuredClone(source)))
    if (
      task.id !== source.taskId ||
      task.conversationId !== source.conversationId ||
      task.input.assistant !== source.assistantEntryId ||
      task.input.callId !== source.callId ||
      canonicalJsonStringify(task.state.checkpoint.arguments) !== canonicalJsonStringify(expected)
    )
      throw new Error('PI_TOOL_SOURCE_REJECTED')
    const entry = z
      .object({
        id: NativeIdentity,
        conversationId: NativeIdentity,
        kind: z.literal('pi.assistant'),
        model: z.array(
          z.object({ role: z.literal('assistant'), content: z.array(z.unknown()) }).passthrough()
        ),
      })
      .passthrough()
      .parse(await reader.readAssistantEntry(structuredClone(source)))
    if (entry.id !== source.assistantEntryId || entry.conversationId !== source.conversationId)
      throw new Error('PI_TOOL_SOURCE_REJECTED')
    const calls = (entry.model[0]?.content ?? []).filter(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        Reflect.get(part, 'type') === 'toolCall' &&
        Reflect.get(part, 'id') === source.callId
    )
    if (calls.length !== 1) throw new Error('PI_TOOL_SOURCE_REJECTED')
    const call = z
      .object({
        type: z.literal('toolCall'),
        id: NativeRef,
        name: z.literal(config.toolName),
        arguments: config.schema,
      })
      .passthrough()
      .parse(calls[0])
    if (canonicalJsonStringify(call.arguments) !== canonicalJsonStringify(expected))
      throw new Error('PI_TOOL_SOURCE_REJECTED')
    // Recheck after both asynchronous native reads; the host gate independently
    // checks the full request and originating approval before any effect.
    await reader.assertCurrent(structuredClone(source))
    const current = Task.parse(await reader.readTask(structuredClone(source)))
    if (canonicalJsonStringify(current) !== canonicalJsonStringify(task))
      throw new Error('PI_TOOL_SOURCE_REJECTED')
    await reader.assertCurrent(structuredClone(source))
    return { args: expected, source, sourceKey: piDurableToolSourceKey(source) }
  } catch {
    // Native/authority reader errors may contain private diagnostics.
    throw new Error('PI_TOOL_SOURCE_REJECTED')
  }
}

/** Verify native durable intent before the host compiler creates J1's full
 * governed request receipt. This does not execute or authorize the tool.
 */
export async function verifyPiDurableToolSource(
  input: unknown,
  objectiveInput: unknown,
  reader: PiDurableToolSourceReader
): Promise<{ source: PiDurableToolSource; sourceKey: string; objective: string }> {
  const verified = await verifyPiDurableToolSourceFor(input, objectiveInput, reader, {
    schema: Objective,
    toolName: 'delegate_child',
  })
  return {
    objective: verified.args.objective,
    source: verified.source,
    sourceKey: verified.sourceKey,
  }
}

/** Management tool variant: verifies the exact `{operation, input}` call. */
export async function verifyPiDurableManagementToolSource(
  input: unknown,
  argumentsInput: unknown,
  reader: PiDurableToolSourceReader
): Promise<{
  readonly args: z.output<typeof ManagementCallArgumentsSchema>
  readonly source: PiDurableToolSource
  readonly sourceKey: string
}> {
  return verifyPiDurableToolSourceFor(input, argumentsInput, reader, {
    schema: ManagementCallArgumentsSchema,
    toolName: 'management_call',
  })
}

import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelSelectionRefSchema,
  RuntimeProviderSelectionSchema,
  ModelExecutionTargetSchema,
} from '@control-plane/contracts'
import { ModelSelectionError } from '@control-plane/model-gateway'

const IntentReference = {
  parse(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 4 ||
      Object.keys(input).some(
        (field) => !['workspaceId', 'intentId', 'selectionRef', 'selectionRevision'].includes(field)
      ) ||
      typeof input.intentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.intentId
      ) ||
      !Number.isSafeInteger(input.selectionRevision) ||
      input.selectionRevision < 1
    )
      throw new ModelSelectionError('SELECTION_CHANGED')
    return {
      workspaceId: IdentifierSchemas.workspaceId.parse(input.workspaceId),
      intentId: input.intentId,
      selectionRef: ModelSelectionRefSchema.parse(input.selectionRef),
      selectionRevision: input.selectionRevision,
    }
  },
}

/** Test-host composition only. The authenticated product reader supplies refs;
 * the actual metadata service resolves them. This does not grant execution or
 * spending authority, construct a payer, or replace the canonical funding facade.
 * Retention is process-local: restart qualification needs the canonical intent store.
 */
export function createSelectedModelHostBridge({ selections, target }) {
  const acceptedTarget = ModelExecutionTargetSchema.parse(target)
  const intents = new Map()
  const fail = () => {
    throw new ModelSelectionError('SELECTION_CHANGED')
  }
  const key = ({ workspaceId, intentId }) => `${workspaceId}/${intentId}`
  const resolve = async (reference) => {
    const selection = RuntimeProviderSelectionSchema.parse(
      await selections.resolveSelection({
        workspaceId: reference.workspaceId,
        selectionRef: reference.selectionRef,
        selectionRevision: reference.selectionRevision,
      })
    )
    if (
      selection.workspaceId !== reference.workspaceId ||
      selection.selectionRef !== reference.selectionRef ||
      selection.selectionRevision !== reference.selectionRevision ||
      Object.keys(acceptedTarget).some((field) => selection[field] !== acceptedTarget[field])
    )
      fail()
    await selections.assertReady(selection)
    return selection
  }
  const accepted = async (input) => {
    const reference = IntentReference.parse(input)
    const winner = intents.get(key(reference))
    if (!winner || canonicalJsonStringify(winner.reference) !== canonicalJsonStringify(reference))
      fail()
    const selection = await resolve(reference)
    if (canonicalJsonStringify(selection) !== winner.pin) fail()
    return selection
  }
  return {
    async bindIntent(input) {
      const reference = IntentReference.parse(input)
      const selection = await resolve(reference)
      const pin = canonicalJsonStringify(selection)
      // Recheck after awaits: concurrent registrations have one immutable winner.
      const winner = intents.get(key(reference))
      if (
        winner &&
        (winner.pin !== pin ||
          canonicalJsonStringify(winner.reference) !== canonicalJsonStringify(reference))
      )
        fail()
      if (!winner) intents.set(key(reference), { reference: structuredClone(reference), pin })
      return structuredClone(selection)
    },
    resolveIntent: accepted,
    /** Supply this same port to canonicalModelHost selections; both native provider
     * and spending consumers must still use canonicalModelHost.forExecution.
     */
    forIntent(input) {
      const reference = IntentReference.parse(input)
      const assertExact = async (candidate) => {
        const current = await accepted(reference)
        if (
          canonicalJsonStringify(RuntimeProviderSelectionSchema.parse(candidate)) !==
          canonicalJsonStringify(current)
        )
          fail()
        return current
      }
      return {
        async resolveSelection(query) {
          if (
            query.workspaceId !== reference.workspaceId ||
            query.selectionRef !== reference.selectionRef ||
            query.selectionRevision !== reference.selectionRevision
          )
            fail()
          return accepted(reference)
        },
        assertReady: assertExact,
        async withCredential(candidate, authority, use) {
          const current = await assertExact(candidate)
          return selections.withCredential(current, authority, async (secret) => {
            await assertExact(current)
            return use(secret)
          })
        },
      }
    },
  }
}

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelSelectionReferenceSchema,
} from '@control-plane/contracts'
import {
  ModelExecutionTargetSchema,
  RuntimeProviderSelectionSchema,
  type ModelSelectionService,
} from '@control-plane/model-gateway'

const Input = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  admissionRef: z.string().min(1).max(256),
  role: z.enum(['lead', 'child']),
  canonicalActorPrincipalId: z
    .string()
    .regex(/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestedSelection: ModelSelectionReferenceSchema.optional(),
})
const Retained = z.strictObject({
  bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  selection: ModelSelectionReferenceSchema,
})

/** Host-only resolver. Input must come from current canonical product/child request authority,
 * never an HTTP or tool payload. This confers no budget, funding or credential authority.
 */
export function createProductionRoleModelSelection(options: {
  database: DatabaseSync
  selections: Pick<ModelSelectionService, 'select' | 'resolveSelection' | 'assertReady'>
  target: z.output<typeof ModelExecutionTargetSchema>
}) {
  const target = ModelExecutionTargetSchema.parse(options.target)
  options.database.exec(
    'CREATE TABLE IF NOT EXISTS pi_production_role_selections (workspace_id TEXT NOT NULL, admission_ref TEXT NOT NULL, role TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(workspace_id,admission_ref,role))'
  )
  const read = (input: z.output<typeof Input>) => {
    const row = options.database
      .prepare(
        'SELECT record FROM pi_production_role_selections WHERE workspace_id=? AND admission_ref=? AND role=?'
      )
      .get(input.workspaceId, input.admissionRef, input.role)
    return row ? Retained.parse(JSON.parse(String(row['record']))) : undefined
  }
  const exact = async (
    input: z.output<typeof Input>,
    reference: z.output<typeof ModelSelectionReferenceSchema>
  ) => {
    const selection = RuntimeProviderSelectionSchema.parse(
      await options.selections.resolveSelection({
        workspaceId: input.workspaceId,
        ...reference,
      })
    )
    if (
      selection.workspaceId !== input.workspaceId ||
      selection.selectionRef !== reference.selectionRef ||
      selection.selectionRevision !== reference.selectionRevision ||
      Object.entries(target).some(
        ([key, value]) => selection[key as keyof typeof selection] !== value
      )
    )
      throw new Error('PI_ROLE_SELECTION_INCOMPATIBLE')
    await options.selections.assertReady(selection)
    return selection
  }
  return {
    async resolve(raw: unknown) {
      const input = Input.parse(raw)
      const bindingDigest = `sha256:${createHash('sha256').update(canonicalJsonStringify({ input, target })).digest('hex')}`
      let retained = read(input)
      if (!retained) {
        // Only the requested role's default is eligible; never inherit the lead model.
        const selected =
          input.requestedSelection ??
          (await options.selections.select({
            workspaceId: input.workspaceId,
            role: input.role,
            target,
          }))
        const candidate = ModelSelectionReferenceSchema.parse({
          selectionRef: selected.selectionRef,
          selectionRevision: selected.selectionRevision,
        })
        const selection = await exact(input, candidate)
        const proposed = Retained.parse({
          bindingDigest,
          selection: {
            selectionRef: selection.selectionRef,
            selectionRevision: selection.selectionRevision,
          },
        })
        options.database
          .prepare('INSERT OR IGNORE INTO pi_production_role_selections VALUES (?,?,?,?)')
          .run(input.workspaceId, input.admissionRef, input.role, canonicalJsonStringify(proposed))
        retained = read(input)
      }
      if (!retained || retained.bindingDigest !== bindingDigest)
        throw new Error('PI_ROLE_SELECTION_CHANGED')
      // Reopen/resume uses the exact winner, even if a workspace default has changed.
      return exact(input, retained.selection)
    },
  }
}

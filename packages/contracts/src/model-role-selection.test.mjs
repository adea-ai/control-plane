import { expect, test } from 'bun:test'
import {
  ModelSelectionReferenceSchema,
  RequestedRoleModelSelectionsSchema,
} from './model-connections.ts'
const reference = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
test('requested role choices contain only immutable selection references', () => {
  expect(RequestedRoleModelSelectionsSchema.parse({ lead: reference, child: reference })).toEqual({
    lead: reference,
    child: reference,
  })
  expect(RequestedRoleModelSelectionsSchema.parse({ child: reference })).toEqual({
    child: reference,
  })
  for (const value of [
    {},
    { lead: { ...reference, credential: 'secret' } },
    { lead: { ...reference, selectionRevision: 0 } },
    { direct: reference },
    { lead: { ...reference, provider: 'openai' } },
    { lead: { ...reference, selectionRef: 'mconn_invalid' } },
  ])
    expect(RequestedRoleModelSelectionsSchema.safeParse(value).success).toBe(false)
  expect(
    ModelSelectionReferenceSchema.safeParse({ ...reference, workspaceId: 'caller' }).success
  ).toBe(false)
})

import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import {
  RuntimeExecutionHandleSchema,
  RuntimeExecutionStateSchema,
  RuntimeStartRequestSchema,
  type RuntimeExecutionHandle,
} from '@control-plane/runtime-sdk'
import { PiDurableAdmissionSchema, type DurableExecutionAuthority } from './contracts.js'
import type { SqliteDurableJournal } from './journal.js'
import {
  assertGrantMatchesAuthority,
  assertCurrentPiChildContinuation,
  assertPiChildContinuationSnapshot,
  type PiChildContinuationGrant,
  type PiChildContinuationGrantRepository,
  type PiChildContinuationSnapshot,
  type PiChildContinuationCurrentAuthorityPort,
} from './child-continuation.js'

export interface PiChildContinuationAuthorityOptions {
  readonly repository: Pick<PiChildContinuationGrantRepository, 'getByChildAttempt'>
  /** Fresh canonical lineage plus the exact existing child journal. Never
   * creates a session, guesses a latest attempt, or reserves another budget. */
  readonly readSnapshot: (grant: PiChildContinuationGrant) => Promise<PiChildContinuationSnapshot>
  readonly current: PiChildContinuationCurrentAuthorityPort
  /** Existing strict child admission guard, including active parent state.
   * Used only before the host has retained any continuation grant. */
  readonly assertFreshAuthority: (authority: DurableExecutionAuthority) => Promise<void>
  /** Same current original actor/scope/provider/recorded funding reader used
   * by the native provider and spending facade. Grant presence cannot bypass it. */
  readonly assertSendAuthority: (
    grant: PiChildContinuationGrant,
    authority: DurableExecutionAuthority
  ) => Promise<void>
  /** Independent audience/publication check. A retained result or send grant
   * never authorizes delivery to a changed user/channel audience. */
  readonly assertPublicationAuthority: (grant: PiChildContinuationGrant) => Promise<void>
  readonly now: () => string
}

function denied(): never {
  throw new Error('PI_CHILD_CONTINUATION_REJECTED')
}

/** Resume authority for an already admitted child only. It does not expose
 * start, approval, replacement selection, budget allocation or grant renewal. */
export function createPiChildContinuationAuthority(options: PiChildContinuationAuthorityOptions) {
  for (const port of [
    options.repository?.getByChildAttempt,
    options.readSnapshot,
    options.current?.readCurrent,
    options.assertFreshAuthority,
    options.assertSendAuthority,
    options.assertPublicationAuthority,
    options.now,
  ])
    if (typeof port !== 'function') denied()

  async function find(authority: DurableExecutionAuthority) {
    const request = RuntimeStartRequestSchema.parse(authority.request)
    const workspaceId = assertExecutionPlanIntegrity(request.executionPlan).correlation.workspaceId
    const grant = await options.repository.getByChildAttempt(workspaceId, request.attemptId)
    if (grant) assertGrantMatchesAuthority(grant, authority)
    return grant
  }
  async function check(grant: PiChildContinuationGrant, authority: DurableExecutionAuthority) {
    assertGrantMatchesAuthority(grant, authority)
    assertPiChildContinuationSnapshot(grant, await options.readSnapshot(grant), {
      mode: 'resume',
      now: options.now(),
    })
    await assertCurrentPiChildContinuation(grant, authority, options.current, options.now)
    assertPiChildContinuationSnapshot(grant, await options.readSnapshot(grant), {
      mode: 'resume',
      now: options.now(),
    })
    await options.assertSendAuthority(grant, structuredClone(authority))
    // Neither the send-authority await nor a concurrent completion/retry may
    // turn an obsolete lineage or expired grant into dispatch authority.
    assertPiChildContinuationSnapshot(grant, await options.readSnapshot(grant), {
      mode: 'resume',
      now: options.now(),
    })
    await assertCurrentPiChildContinuation(grant, authority, options.current, options.now)
    assertPiChildContinuationSnapshot(grant, await options.readSnapshot(grant), {
      mode: 'resume',
      now: options.now(),
    })
  }
  return {
    async assertAuthority(authority: DurableExecutionAuthority): Promise<void> {
      const grant = await find(authority)
      if (!grant) {
        await options.assertFreshAuthority(structuredClone(authority))
        return
      }
      await check(grant, authority)
    },
    async assertResume(
      authority: DurableExecutionAuthority,
      handleInput: RuntimeExecutionHandle
    ): Promise<PiChildContinuationGrant> {
      const handle = RuntimeExecutionHandleSchema.parse(handleInput)
      const grant = await find(authority)
      if (!grant || canonicalJsonStringify(handle) !== canonicalJsonStringify(grant.child.handle))
        denied()
      await check(grant, authority)
      return grant
    },
    async assertPublication(grant: PiChildContinuationGrant): Promise<void> {
      // Deliberately independent of send eligibility: already committed evidence
      // can be retained after revocation, but audience delivery still fails closed.
      await options.assertPublicationAuthority(structuredClone(grant))
    },
  }
}

/** Bound metadata reader for a retained session. No process ownership claim,
 * native engine construction, inference reconciliation or new journal admission. */
export function readPiChildContinuationJournal(
  journal: Pick<SqliteDurableJournal, 'get'>,
  input: RuntimeExecutionHandle
) {
  const handle = RuntimeExecutionHandleSchema.parse(input)
  const record = journal.get(handle.handleId)
  if (!record.admission || typeof record.admission !== 'object') denied()
  const storedHandle = RuntimeExecutionHandleSchema.parse(Reflect.get(record.admission, 'handle'))
  const request = RuntimeStartRequestSchema.parse(Reflect.get(record.admission, 'request'))
  const admission = PiDurableAdmissionSchema.parse(Reflect.get(record.admission, 'admission'))
  if (
    record.handleId !== handle.handleId ||
    record.attemptId !== handle.attemptId ||
    canonicalJsonStringify(storedHandle) !== canonicalJsonStringify(handle) ||
    request.attemptId !== handle.attemptId
  )
    denied()
  return {
    handle: storedHandle,
    request,
    admission,
    state: RuntimeExecutionStateSchema.parse(record.state),
  }
}

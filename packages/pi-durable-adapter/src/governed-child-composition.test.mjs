import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGovernedChildCompositionFixture } from './governed-child-composition.fixture.mjs'
import { PiDurableChildProgressScanner } from '../../../apps/control-api/src/pi-durable/child-progress-scanner.ts'

async function fixture(run, options) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-governed-child-composed-'))
  let f
  try {
    f = await createGovernedChildCompositionFixture(directory, options)
    await run(f)
  } finally {
    await f?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test(
  'actual native delegate_child passes durable gate and canonical J1 admission into a separately funded Pi child and retained terminal inbox',
  () =>
    fixture(async (f) => {
      expect((await f.storage.executions.getExecution(f.ids.parentExecutionId)).state).toBe(
        'accepted'
      )
      expect((await f.storage.executions.getAttempt(f.leadRequest.attemptId)).state).toBe('queued')
      const leadHandle = await f.leadRuntime.adapter.start(f.leadRequest)
      await f.leadRuntime.adapter.drain()
      const lead = await f.leadRuntime.adapter.status(leadHandle)
      expect(lead.state).toBe('completed')
      expect(f.host.starts).toHaveLength(1)
      expect(f.state.parentAtChildAdmission).toEqual([{ execution: 'running', attempt: 'running' }])
      const runningReceipt = JSON.parse(
        f.leadDatabase.prepare('SELECT receipt_json FROM pi_lead_running_receipts').get()
          .receipt_json
      )
      expect(runningReceipt.handle).toEqual(leadHandle)
      expect(
        (await f.storage.executions.getAttempt(f.leadRequest.attemptId)).runtime.externalSessionId
      ).toBeUndefined()
      expect(f.parentNative.requests).toHaveLength(2)
      const toolMessage = f.parentNative.requests[1].messages.find((value) => value.role === 'tool')
      const returned = JSON.parse(toolMessage.content)
      expect(returned).toMatchObject({
        schemaVersion: 'pi-delegate-child-outcome/v1',
        state: 'succeeded',
        delegationId: f.ids.delegationId,
        childExecutionId: f.ids.childExecutionId,
        childAttemptId: f.ids.childAttemptId,
      })
      const canonicalAdmission = await f.storage.admissions.getByRequestId(f.host.request.requestId)
      expect(canonicalAdmission.sourceKey).toMatch(/^pi-tool:[a-f0-9]{64}$/)
      expect(canonicalAdmission.request.audit.principalRef).toBe(f.actor)
      expect(canonicalAdmission.request.audit.principalRef).not.toBe('lease:workspace-lead')
      const childRequest = f.host.starts[0]
      expect(childRequest.executionId).toBe(f.ids.childExecutionId)
      expect(childRequest.attemptId).toBe(f.ids.childAttemptId)
      expect(childRequest.executionPlan.parentExecutionPlan.contentDigest).toBe(
        f.leadRequest.executionPlan.contentDigest
      )
      expect(childRequest.executionPlan.correlation.executionScope).toEqual({
        schemaVersion: 1,
        kind: 'project',
        projectId: f.ids.projectId,
      })
      expect(childRequest.attemptBudget).toEqual(f.state.budgets[0])
      expect(childRequest.attemptBudget.reservationKey).not.toBe(
        f.leadRequest.attemptBudget.reservationKey
      )
      await f.childRuntime.adapter.drain()
      const childHandle = await f.childRuntime.adapter.start(childRequest)
      const child = await f.childRuntime.adapter.status(childHandle)
      expect(child.state).toBe('completed')
      expect(child.result.output.text).toBe('Bounded child evidence.')
      expect(f.child.requests).toHaveLength(1)
      expect(f.child.requests[0].model).toBe('separate-child-model')
      expect(f.child.requests[0].tools ?? []).toHaveLength(0)
      const retainedChild = f.childRuntime.adapter.journal.get(childHandle.handleId)
      expect(retainedChild.admission.admission.selection).toEqual(f.selections.child)
      expect(
        f.state.selections.some(
          (value) =>
            value.role === 'child' &&
            value.selection.selectionRef === f.selections.lead.selectionRef
        )
      ).toBe(false)
      const leadEntries = await f.ledger.entries(f.ids.workspaceId, f.ids.parentExecutionId)
      const childEntries = await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)
      expect(leadEntries.filter((value) => value.kind === 'model_usage')).toHaveLength(2)
      expect(childEntries.filter((value) => value.kind === 'model_usage')).toHaveLength(1)
      expect(childEntries.filter((value) => value.kind === 'model_reservation')).toHaveLength(1)
      expect(childEntries.filter((value) => value.kind === 'model_usage')[0]).toMatchObject({
        attemptId: f.ids.childAttemptId,
        reservationKey: childRequest.attemptBudget.reservationKey,
        fundingSource: 'byo_api',
        costExact: true,
        costMicrounits: 15,
      })
      expect(
        f.state.spendingChecks
          .filter((value) => value.role === 'child')
          .every((value) => value.selection.selectionRef === f.selections.child.selectionRef)
      ).toBe(true)

      // Production scanner uses persisted canonical identities and actual native
      // running/terminal receipts, independently from the test's starts array.
      expect(await f.scanner.scan(f.childRuntime.adapter)).toEqual({
        published: 1,
        skipped: 0,
        blocked: [],
      })
      expect(await f.scanner.scan(f.childRuntime.adapter)).toEqual({
        published: 1,
        skipped: 0,
        blocked: [],
      })
      const record = await f.storage.delegations.get(f.ids.delegationId)
      expect(record.state).toBe('completed')
      expect(record.terminalPublication.status).toBe('published')
      expect(
        (await f.storage.events.list()).filter((value) => value.type === 'delegation.completed')
      ).toHaveLength(1)
      expect(f.host.starts).toHaveLength(1)
      expect(f.child.requests).toHaveLength(1)
      expect(JSON.stringify(retainedChild)).not.toContain('fixture-child-no-account')
      await f.leadRuntime.close()
      await f.childRuntime.close()
      const reopened = await f.reopenCanonical()
      try {
        expect(await reopened.storage.admissions.getByRequestId(f.host.request.requestId)).toEqual(
          canonicalAdmission
        )
        expect(
          (await reopened.storage.events.list()).filter(
            (value) => value.type === 'delegation.completed'
          )
        ).toHaveLength(1)
        expect(
          (await reopened.storage.delegations.get(f.ids.delegationId)).terminalPublication.status
        ).toBe('published')
        expect(await reopened.storage.executions.listAttempts(f.ids.childExecutionId)).toHaveLength(
          1
        )
        const artifact = await reopened.provider.transaction((tx) =>
          tx.get('pi-child-terminal-results', f.ids.childAttemptId)
        )
        expect(artifact.value).toEqual(child.result)
      } finally {
        reopened.provider.close()
      }
    }),
  30000
)

test(
  'separate child spending revocation blocks its physical provider dispatch while the canonical child admission and budget remain evidence',
  () =>
    fixture(
      async (f) => {
        const handle = await f.leadRuntime.adapter.start(f.leadRequest)
        await f.leadRuntime.adapter.drain()
        expect((await f.leadRuntime.adapter.status(handle)).state).toBe('completed')
        expect(f.host.starts).toHaveLength(1)
        await f.childRuntime.adapter.drain()
        const childHandle = await f.childRuntime.adapter
          .start(f.host.starts[0])
          .catch(() => undefined)
        expect(childHandle).toBeUndefined()
        expect(f.child.requests).toHaveLength(0)
        expect(f.parentNative.requests).toHaveLength(2)
        const childEntries = await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)
        expect(childEntries.filter((value) => value.kind === 'reservation')).toHaveLength(1)
        expect(childEntries.filter((value) => value.kind === 'model_reservation')).toHaveLength(0)
        expect(childEntries.filter((value) => value.kind === 'model_usage')).toHaveLength(0)
        expect((await f.storage.delegations.get(f.ids.delegationId)).state).toBe('dispatched')
        expect(
          (await f.storage.events.list()).filter((value) => value.type === 'delegation.completed')
        ).toHaveLength(0)
      },
      { revokeChildBeforeDispatch: true }
    ),
  30000
)

test(
  'actual J1 admission and native approval checkpoint reopen before any child funding or dispatch and resume the exact compiled source',
  () =>
    fixture(async (f) => {
      f.state.approved = false
      const handle = await f.leadRuntime.adapter.start(f.leadRequest)
      await f.leadRuntime.adapter.drain()
      expect((await f.leadRuntime.adapter.status(handle)).state).toBe('awaiting_input')
      const retained = await f.storage.admissions.getByRequestId(f.host.request.requestId)
      expect(retained.sourceKey).toMatch(/^pi-tool:[a-f0-9]{64}$/)
      expect(f.host.starts).toHaveLength(0)
      expect(f.state.budgets).toHaveLength(0)
      expect(f.child.requests).toHaveLength(0)
      expect(f.parentNative.requests).toHaveLength(1)
      expect(await f.storage.delegations.listByParent(f.ids.parentExecutionId)).toHaveLength(0)
      expect(
        (await f.ledger.entries(f.ids.workspaceId, f.ids.parentExecutionId)).filter(
          (value) => value.kind === 'model_usage'
        )
      ).toHaveLength(1)
      await f.reopenLead()
      expect(await f.leadRuntime.adapter.start(f.leadRequest)).toEqual(handle)
      expect(f.parentNative.requests).toHaveLength(1)
      const acknowledgement = {
        interactionId: f.host.request.approval.interactionId,
        idempotencyKey: 'composed-approval:one',
        decision: 'approve',
      }
      await expect(f.leadRuntime.adapter.submitApproval(handle, acknowledgement)).rejects.toThrow(
        'PI_APPROVAL_NOT_AUTHORITATIVE'
      )
      f.state.approved = true
      await f.leadRuntime.adapter.submitApproval(handle, acknowledgement)
      expect(f.host.starts).toHaveLength(0)
      expect(f.child.requests).toHaveLength(0)
      await f.leadRuntime.adapter.reconcile(handle)
      await f.leadRuntime.adapter.drain()
      await f.childRuntime.adapter.drain()
      expect((await f.leadRuntime.adapter.status(handle)).state).toBe('completed')
      expect(f.host.starts).toHaveLength(1)
      expect(f.parentNative.requests).toHaveLength(2)
      expect(f.child.requests).toHaveLength(1)
      expect(await f.storage.admissions.getByRequestId(f.host.request.requestId)).toEqual(retained)
      const childHandle = await f.childRuntime.adapter.start(f.host.starts[0])
      expect((await f.childRuntime.adapter.status(childHandle)).state).toBe('completed')
      expect(f.child.requests).toHaveLength(1)
      expect(
        (await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)).filter(
          (value) => value.kind === 'model_usage'
        )
      ).toHaveLength(1)
      expect(
        (await f.ledger.entries(f.ids.workspaceId, f.ids.parentExecutionId)).filter(
          (value) => value.kind === 'model_usage'
        )
      ).toHaveLength(2)
    }),
  30000
)

test(
  'observer fault after actual J1 running CAS retains canonical SQLite state and next scan publishes terminal once without another native send',
  () =>
    fixture(async (f) => {
      const handle = await f.leadRuntime.adapter.start(f.leadRequest)
      await f.leadRuntime.adapter.drain()
      await f.childRuntime.adapter.drain()
      expect((await f.leadRuntime.adapter.status(handle)).state).toBe('completed')
      const faulted = new PiDurableChildProgressScanner({
        ...f.scanner.options,
        bridge: {
          recordProgress: async (identity, progress) => {
            await f.host.bridge.recordProgress(identity, progress)
            if (progress.state === 'running')
              throw new Error('FAULT_AFTER_CANONICAL_RUNNING_COMMIT')
          },
        },
      })
      expect((await faulted.scan(f.childRuntime.adapter)).blocked).toHaveLength(1)
      expect((await f.storage.executions.getAttempt(f.ids.childAttemptId)).state).toBe('running')
      expect((await f.storage.delegations.get(f.ids.delegationId)).state).toBe('running')
      expect(
        (await f.storage.events.list()).filter((value) => value.type === 'delegation.completed')
      ).toHaveLength(0)
      // Fresh observer reads the retained canonical state, not the crashed observer's snapshot.
      const resumed = new PiDurableChildProgressScanner(f.scanner.options)
      expect(await resumed.scan(f.childRuntime.adapter)).toEqual({
        published: 1,
        skipped: 0,
        blocked: [],
      })
      expect(await resumed.scan(f.childRuntime.adapter)).toEqual({
        published: 1,
        skipped: 0,
        blocked: [],
      })
      expect((await f.storage.delegations.get(f.ids.delegationId)).terminalPublication.status).toBe(
        'published'
      )
      expect(
        (await f.storage.events.list()).filter((value) => value.type === 'delegation.completed')
      ).toHaveLength(1)
      expect(f.parentNative.requests).toHaveLength(2)
      expect(f.child.requests).toHaveLength(1)
    }),
  30000
)

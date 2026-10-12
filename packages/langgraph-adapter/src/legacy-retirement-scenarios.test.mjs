import { describe, expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import {
  LEGACY_CHECKPOINT_NAMESPACE,
  LEGACY_GRAPH_API,
  LEGACY_STATUS_ITEM_LIMIT,
  LEGACY_STATUS_SCHEMA,
  buildLegacyOperatorStatus,
  claimLegacyDrainFence,
  createLegacyAdmissionGuard,
  createLegacyResumeFence,
  evaluateLegacyAdmissionGate,
  planLegacyDrain,
  readLegacyRemainder,
  releaseLegacyDrainFence,
} from './legacy-retirement.ts'
import {
  adapterFor,
  assertedDeployed,
  buildMixedStore,
  digest,
  disposable,
  disposableStore,
  executionIds,
  injectedVerifier,
  itemFor,
  planDigest,
  planId,
  putOrphanThread,
  reopen,
  request,
  resumeInput,
  resumeRequest,
  runRequest,
  scope,
  storageThread,
  writeExecution,
  writePlanRecord,
  writeRawRecord,
} from './legacy-retirement.fixture.mjs'

// Evidence values below are typed test inputs. They exercise the arithmetic, never a real replacement report.
const admissibleGraphs = [request.graph]
const label = `${request.graph.graphDefinitionId}@${request.graph.graphVersion}`
const pin = { executionPlanId: planId, contentDigest: planDigest }
const planRecord = {
  executionPlanId: planId,
  contentDigest: planDigest,
  graph: { reference: request.graph },
}
const divergent = [
  { graph: request.graph, outcome: 'evidence-divergent', reportDigest: digest('1') },
]
const equivalent = [
  { graph: request.graph, outcome: 'evidence-equivalent', reportDigest: digest('2') },
]
const proven = [{ graph: request.graph, outcome: 'proven' }]
const unproven = [{ graph: request.graph, outcome: 'unproven' }]

describe('legacy retirement scenarios in disposable state (M16.03, #940)', () => {
  test('restart with three retained threads keeps zero blocked until each thread and execution is terminal', async () => {
    const { directory, path, provider } = await disposableStore()
    const calls = []
    try {
      const inFlight = runRequest({
        executionId: executionIds.primary,
        threadId: 'thread-in-flight',
        idempotencyKey: 'legacy:restart:in-flight',
      })
      const completed = runRequest({
        executionId: executionIds.second,
        threadId: 'thread-completed',
        idempotencyKey: 'legacy:restart:completed',
      })
      const inFlightRun = await adapterFor(provider, { calls }).run(inFlight)
      expect(inFlightRun).toMatchObject({ status: 'awaiting_input' })
      await writeExecution(provider, 'awaiting_input', executionIds.primary)

      const completedRun = await adapterFor(provider, { calls }).run(completed)
      const completedResume = await adapterFor(provider, { calls }).resume(
        resumeRequest(completed, completedRun.checkpointId, 'legacy:restart:completed:resume')
      )
      expect(completedResume).toMatchObject({ status: 'completed' })
      await writeExecution(provider, 'completed', executionIds.second)

      await putOrphanThread(provider, `${request.workspaceId}:${executionIds.orphan}:thread-orphan`)
      provider.close()

      const reopened = await reopen(path)
      try {
        const before = await readLegacyRemainder(reopened, disposable)
        expect(before.counts).toMatchObject({ threads: 3, executionOnly: 0, inFlightExecutions: 1 })
        expect(before.counts.byClassification).toEqual({
          'in-flight': 1,
          'uncertain-effect': 0,
          terminal: 1,
          orphaned: 1,
          unclassified: 0,
          unknown: 0,
        })
        expect(before.zero).toEqual({
          established: false,
          reasons: [
            'DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO',
            'RETAINED_THREADS_PRESENT',
            'IN_FLIGHT_EXECUTIONS_PRESENT',
          ],
        })

        // Resume the interrupted thread after the restart: only the remaining step runs, with no second prepare.
        const resumed = await adapterFor(reopened, { calls }).resume(
          resumeRequest(inFlight, inFlightRun.checkpointId, 'legacy:restart:in-flight:resume')
        )
        expect(resumed).toMatchObject({ status: 'completed' })
        expect(calls).toEqual(['prepare', 'prepare', 'finalize', 'finalize'])
        await writeExecution(reopened, 'completed', executionIds.primary)

        const after = await readLegacyRemainder(reopened, disposable)
        expect(after.counts).toMatchObject({ threads: 3, executionOnly: 0, inFlightExecutions: 0 })
        expect(after.zero).toEqual({
          established: false,
          reasons: ['DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO', 'RETAINED_THREADS_PRESENT'],
        })

        // A caller-asserted deployed scope with an attestation still cannot establish zero while threads remain.
        const asserted = await readLegacyRemainder(reopened, assertedDeployed)
        expect(asserted.zero).toEqual({ established: false, reasons: ['RETAINED_THREADS_PRESENT'] })
        const plan = planLegacyDrain(asserted, { admissibleGraphs })
        expect(plan.handoffEligible).toBe(false)
        expect(plan.removal.satisfied).toBe(false)
        expect(plan.retainedDependencies.length).toBeGreaterThan(0)
        expect(
          evaluateLegacyAdmissionGate({
            remainder: asserted,
            admissibleGraphs,
            replacements: [],
            profiles: [],
            failures: [],
            closureRequested: true,
          }).decision
        ).toBe('open')
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an uncertain effect survives a restart as a handoff blocker, and reconciliation alone does not establish zero', async () => {
    const { directory, path, provider } = await disposableStore()
    try {
      const result = await adapterFor(provider, { failOn: 'prepare' }).run(
        runRequest({ threadId: 'thread-uncertain', idempotencyKey: 'legacy:uncertain:1' })
      )
      expect(result).toMatchObject({ status: 'reconciliation_required' })
      await writeExecution(provider, 'reconciliation_required')
      provider.close()

      const reopened = await reopen(path)
      try {
        const held = await readLegacyRemainder(reopened, disposable)
        expect(itemFor(held, request.executionId)).toMatchObject({
          classification: 'uncertain-effect',
          blockers: ['UNCERTAIN_EFFECT_UNRECONCILED'],
        })
        expect(held.counts.byClassification['uncertain-effect']).toBe(1)
        const heldPlan = planLegacyDrain(held, { admissibleGraphs })
        expect(heldPlan.handoffEligible).toBe(false)
        expect(heldPlan.items[0].blockers).toEqual(['UNCERTAIN_EFFECT_UNRECONCILED'])
        expect(heldPlan.removal.satisfied).toBe(false)

        // Reconciliation is the control plane's transition; the reader only observes it after the restart.
        await writeExecution(reopened, 'failed')
        const reconciled = await readLegacyRemainder(reopened, disposable)
        expect(itemFor(reconciled, request.executionId)).toMatchObject({
          classification: 'terminal',
          blockers: [],
        })
        expect(reconciled.zero).toEqual({
          established: false,
          reasons: ['DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO', 'RETAINED_THREADS_PRESENT'],
        })
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('incompatible replacement evidence keeps the legacy owner, blocks handoff, and leaves the gate open', async () => {
    const { directory, provider } = await disposableStore()
    try {
      await adapterFor(provider).run(request)
      await writePlanRecord(provider, planId, planRecord)
      await writeExecution(provider, 'awaiting_input', executionIds.primary, pin)
      const remainder = await readLegacyRemainder(provider, {
        ...disposable,
        verifyPlan: injectedVerifier,
      })
      expect(itemFor(remainder, request.executionId)).toMatchObject({
        planVerification: 'verified',
        graph: request.graph,
      })

      const incompatible = planLegacyDrain(remainder, {
        replacements: divergent,
        profiles: proven,
        failures: proven,
        admissibleGraphs,
      })
      expect(incompatible.items[0]).toMatchObject({
        selectedOwner: 'legacy-langgraph-saver',
        ownerReasons: ['EVIDENCE_DIVERGENT'],
        handoffEligible: false,
      })
      expect(incompatible.handoffEligible).toBe(false)
      expect(incompatible.removal.satisfied).toBe(false)
      expect(incompatible.removal.reasons).toEqual(
        expect.arrayContaining(['RETAINED_THREADS_PRESENT', 'LEGACY_OWNER_RETAINED'])
      )
      expect(incompatible.retainedDependencies.length).toBeGreaterThan(0)

      expect(
        planLegacyDrain(remainder, {
          replacements: equivalent,
          profiles: unproven,
          failures: proven,
          admissibleGraphs,
        }).items[0].ownerReasons
      ).toEqual(['PROFILE_OR_FAILURE_EVIDENCE_UNPROVEN'])
      expect(
        planLegacyDrain(remainder, {
          replacements: equivalent,
          profiles: proven,
          failures: unproven,
          admissibleGraphs,
        }).items[0].ownerReasons
      ).toEqual(['PROFILE_OR_FAILURE_EVIDENCE_UNPROVEN'])

      // Fully proven equivalence hands the item off once it is terminal. A disposable store that retains the thread still cannot be removed.
      await writeExecution(provider, 'completed', executionIds.primary, pin)
      const finished = await readLegacyRemainder(provider, {
        ...disposable,
        verifyPlan: injectedVerifier,
      })
      const ready = planLegacyDrain(finished, {
        replacements: equivalent,
        profiles: proven,
        failures: proven,
        admissibleGraphs,
      })
      expect(ready.items[0]).toMatchObject({
        selectedOwner: 'typed-replacement',
        handoffEligible: true,
        blockers: [],
      })
      expect(ready.removal).toEqual({
        condition: LEGACY_GRAPH_API.removalCondition,
        satisfied: false,
        reasons: ['DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO', 'RETAINED_THREADS_PRESENT'],
      })

      expect(
        evaluateLegacyAdmissionGate({
          remainder,
          admissibleGraphs,
          replacements: divergent,
          profiles: proven,
          failures: proven,
          closureRequested: true,
        })
      ).toEqual({
        decision: 'open',
        reasons: [
          'REMAINING_NOT_DEPLOYED_SCOPE',
          'REMAINING_ZERO_NOT_ESTABLISHED',
          `REPLACEMENT_NOT_EQUIVALENT:${label}`,
        ],
      })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('removal needs zero, an attestation, and proven admissible-graph coverage, and a divergent replacement blocks it', async () => {
    const { directory, provider } = await disposableStore()
    try {
      // Arithmetic only: an empty disposable store read under a caller-asserted deployed scope.
      const drained = await readLegacyRemainder(provider, assertedDeployed)
      expect(drained.zero).toEqual({ established: true, reasons: [] })

      const uncovered = planLegacyDrain(drained)
      expect(uncovered.removal).toEqual({
        condition: LEGACY_GRAPH_API.removalCondition,
        satisfied: false,
        reasons: ['NO_ADMISSIBLE_GRAPHS_OBSERVED'],
      })
      expect(uncovered.retainedDependencies.length).toBeGreaterThan(0)

      const blocked = planLegacyDrain(drained, {
        replacements: divergent,
        profiles: proven,
        failures: proven,
        admissibleGraphs,
      })
      expect(blocked.removal).toMatchObject({
        satisfied: false,
        reasons: ['ADMISSIBLE_GRAPHS_NOT_COVERED'],
      })

      const covered = planLegacyDrain(drained, {
        replacements: equivalent,
        profiles: proven,
        failures: proven,
        admissibleGraphs,
      })
      expect(covered.removal).toEqual({
        condition: LEGACY_GRAPH_API.removalCondition,
        satisfied: true,
        reasons: [],
      })
      expect(covered.retainedDependencies).toEqual([])

      expect(
        evaluateLegacyAdmissionGate({
          remainder: drained,
          admissibleGraphs,
          replacements: divergent,
          profiles: proven,
          failures: proven,
          closureRequested: true,
        }).decision
      ).toBe('open')
      expect(
        evaluateLegacyAdmissionGate({
          remainder: drained,
          admissibleGraphs,
          replacements: equivalent,
          profiles: proven,
          failures: proven,
          closureRequested: true,
        })
      ).toEqual({ decision: 'closure-eligible', reasons: [] })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a foreign-version checkpoint row blocks zero, is counted as unsupported, and makes every saver resume fail as a retryable RESUME_FAILED', async () => {
    const { directory, path, provider } = await disposableStore()
    const control = await disposableStore()
    const calls = []
    try {
      // Control: the same flow without foreign rows resumes. The failure below comes from the foreign rows alone.
      const controlRun = await adapterFor(control.provider).run(request)
      await expect(
        adapterFor(control.provider).resume(resumeInput(controlRun.checkpointId))
      ).resolves.toMatchObject({ status: 'completed' })
      control.provider.close()

      const first = await adapterFor(provider, { calls }).run(request)
      await writeExecution(provider, 'awaiting_input')
      await writeRawRecord(provider, LEGACY_CHECKPOINT_NAMESPACE, 'foreign-v2', {
        version: 2,
        scope,
        thread: storageThread,
        checkpointId: 'ckpt-foreign',
        kind: 'checkpoint',
      })
      await writeRawRecord(provider, LEGACY_CHECKPOINT_NAMESPACE, 'foreign-unversioned', {
        scope,
        thread: storageThread,
        checkpointId: 'ckpt-unversioned',
        kind: 'write',
      })
      provider.close()

      const reopened = await reopen(path)
      try {
        const remainder = await readLegacyRemainder(reopened, disposable)
        expect(remainder.counts).toMatchObject({
          threads: 1,
          unparseableCheckpointRecords: 2,
          unsupportedVersionCheckpointRecords: 1,
        })
        expect(remainder.zero).toEqual({
          established: false,
          reasons: [
            'DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO',
            'RETAINED_THREADS_PRESENT',
            'IN_FLIGHT_EXECUTIONS_PRESENT',
            'UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT',
          ],
        })
        const asserted = await readLegacyRemainder(reopened, assertedDeployed)
        expect(asserted.zero.established).toBe(false)
        expect(asserted.zero.reasons).toContain('UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT')

        // Pinned pre-existing saver behavior, not changed here: the strict row parse rejects the whole namespace.
        // The adapter sanitizes that into a retryable failed result, so a retrying operator keeps failing until the row is handled.
        await expect(
          adapterFor(reopened, { calls }).resume(resumeInput(first.checkpointId))
        ).resolves.toMatchObject({
          status: 'failed',
          failure: { code: 'RESUME_FAILED', retryable: true },
        })
        expect(calls).toEqual(['prepare'])
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(control.directory, { recursive: true, force: true })
    }
  })

  test('a plan that fails canonical verification is reported as unverified, never as a trusted graph', async () => {
    const { directory, provider } = await disposableStore()
    try {
      await adapterFor(provider).run(request)
      // An incomplete plan record: canonical verification rejects it, so its graph reference is never trusted.
      await writePlanRecord(provider, planId, {
        executionPlanId: planId,
        contentDigest: planDigest,
      })
      // A plan record that cannot be identified at all is counted as unparseable.
      await writePlanRecord(provider, 'pln_01JABCDEF0123456789ABCDEFH', {
        contentDigest: planDigest,
      })
      await writeExecution(provider, 'awaiting_input', executionIds.primary, pin)

      const remainder = await readLegacyRemainder(provider, disposable)
      expect(remainder.counts).toMatchObject({ plans: 2, plansUnverified: 1, unparseablePlans: 1 })
      const item = itemFor(remainder, request.executionId)
      expect(item).toMatchObject({ planVerification: 'unverified', blockers: ['IN_FLIGHT_WORK'] })
      expect(item.graph).toBeUndefined()
      expect(planLegacyDrain(remainder).items[0]).toMatchObject({
        selectedOwner: 'legacy-langgraph-saver',
        ownerReasons: ['PLAN_UNVERIFIED'],
        handoffEligible: false,
      })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the operator status is bounded, shows every retained shape, and carries no store path', async () => {
    const { directory, path, provider } = await disposableStore()
    try {
      await buildMixedStore(provider)
      const remainder = await readLegacyRemainder(provider, disposable)
      const plan = planLegacyDrain(remainder, { admissibleGraphs })
      const admission = evaluateLegacyAdmissionGate({
        remainder,
        admissibleGraphs,
        replacements: [],
        profiles: [],
        failures: [],
        closureRequested: false,
      })
      const status = buildLegacyOperatorStatus({ remainder, plan, admission })

      expect(status).toMatchObject({
        schema: LEGACY_STATUS_SCHEMA,
        api: { path: 'graphs', version: '1', lifecycle: 'deprecated' },
        scope: 'disposable-local-store',
        readComplete: true,
        exact: true,
        zero: { established: false },
        removal: { satisfied: false },
        admission: { decision: 'open' },
      })
      expect(status.counts).toMatchObject({
        threads: 3,
        executionOnly: 1,
        unparseableCheckpointRecords: 1,
        unsupportedVersionCheckpointRecords: 1,
        plans: 1,
        plansUnverified: 1,
      })
      expect(status.blockers).toEqual({
        IN_FLIGHT_WORK: 2,
        UNCERTAIN_EFFECT_UNRECONCILED: 1,
        ORPHANED_THREAD: 1,
      })
      expect(status.owners).toEqual({ 'legacy-langgraph-saver': 4 })
      expect(status.removal.reasons).toEqual([
        'DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO',
        'RETAINED_THREADS_PRESENT',
        'IN_FLIGHT_EXECUTIONS_PRESENT',
        'UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT',
        'ADMISSIBLE_GRAPHS_NOT_COVERED',
        'LEGACY_OWNER_RETAINED',
      ])
      expect(status.retainedDependencies).toHaveLength(2)
      expect(status.items).toMatchObject({ total: 4, shown: 4, truncated: false })
      expect(status.items.entries.map((entry) => entry.identity)).toEqual([
        `execution:${executionIds.queued}`,
        storageThread,
        `${request.workspaceId}:${executionIds.second}:thread-uncertain`,
        `${request.workspaceId}:${executionIds.orphan}:thread-orphan`,
      ])
      expect(status.items.entries.find((entry) => entry.identity === storageThread)).toMatchObject({
        planVerification: 'unverified',
        ownerReasons: ['PLAN_UNVERIFIED'],
      })

      const json = JSON.stringify(status)
      expect(json).not.toContain(directory)
      expect(json).not.toContain(path)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the operator status lists at most the item limit in identity order and reports the full total', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const threadIds = Array.from(
        { length: LEGACY_STATUS_ITEM_LIMIT + 1 },
        (_, index) =>
          `${request.workspaceId}:${executionIds.orphan}:orphan-${String(index).padStart(2, '0')}`
      )
      for (const threadId of threadIds) await putOrphanThread(provider, threadId)

      const remainder = await readLegacyRemainder(provider, disposable)
      const status = buildLegacyOperatorStatus({ remainder, plan: planLegacyDrain(remainder) })
      expect(status.counts.threads).toBe(LEGACY_STATUS_ITEM_LIMIT + 1)
      expect(status.items).toMatchObject({
        total: LEGACY_STATUS_ITEM_LIMIT + 1,
        shown: LEGACY_STATUS_ITEM_LIMIT,
        truncated: true,
      })
      expect(status.items.entries.map((entry) => entry.identity)).toEqual(
        [...threadIds].toSorted().slice(0, LEGACY_STATUS_ITEM_LIMIT)
      )
      expect(status.admission).toBeUndefined()
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a stale release from an earlier claim cannot release a later claim by the same owner, across a restart', async () => {
    const { directory, path, provider } = await disposableStore()
    try {
      const first = await claimLegacyDrainFence(provider, {
        storageThreadId: storageThread,
        owner: 'drain-a',
      })
      expect(await releaseLegacyDrainFence(provider, first)).toBe(true)
      const second = await claimLegacyDrainFence(provider, {
        storageThreadId: storageThread,
        owner: 'drain-a',
      })
      expect(second.generation).toBe(first.generation + 1)
      // Same-owner re-claim while held is idempotent: the held handle comes back and no generation is spent.
      expect(
        await claimLegacyDrainFence(provider, { storageThreadId: storageThread, owner: 'drain-a' })
      ).toEqual(second)
      provider.close()

      const reopened = await reopen(path)
      try {
        // The live record was deleted and recreated, so its revision restarted. Only the generation tells the claims apart.
        expect(second.revision).toBe(first.revision)
        await expect(releaseLegacyDrainFence(reopened, first)).rejects.toMatchObject({
          code: 'LEGACY_DRAIN_FENCE_STALE',
        })
        await expect(
          releaseLegacyDrainFence(reopened, { ...second, owner: 'drain-b' })
        ).rejects.toMatchObject({
          code: 'LEGACY_DRAIN_FENCE_NOT_OWNED',
        })
        await expect(
          createLegacyResumeFence(reopened).assertResumeAllowed(storageThread)
        ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
        expect(await releaseLegacyDrainFence(reopened, second)).toBe(true)
        await expect(
          createLegacyResumeFence(reopened).assertResumeAllowed(storageThread)
        ).resolves.toBeUndefined()
        // The generation keeps advancing across the restart, so no reclaim reuses an earlier one.
        const third = await claimLegacyDrainFence(reopened, {
          storageThreadId: storageThread,
          owner: 'drain-a',
        })
        expect(third.generation).toBe(second.generation + 1)
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a composition that observes no legacy inventory keeps the admission gate open and never fabricates a remainder', async () => {
    const unobserved = {
      admissibleGraphs: [],
      replacements: [],
      profiles: [],
      failures: [],
      closureRequested: true,
    }
    expect(evaluateLegacyAdmissionGate(unobserved)).toEqual({
      decision: 'open',
      reasons: ['REMAINING_NOT_OBSERVED', 'NO_ADMISSIBLE_GRAPHS_OBSERVED'],
    })
    await expect(
      createLegacyAdmissionGuard(() => unobserved).assertNewAdmissionAllowed()
    ).resolves.toBeUndefined()
  })

  test('a retained uncertain effect refuses admission for its execution even when the gate would stay open', async () => {
    const admissionRequest = {
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      storageThreadId: 'wsp_01JABCDEF0123456789ABCDEFG:exe_01JABCDEF0123456789ABCDEFG:thread-1',
    }
    const open = {
      admissibleGraphs: [],
      replacements: [],
      profiles: [],
      failures: [],
      closureRequested: false,
    }
    await expect(
      createLegacyAdmissionGuard(() => ({
        ...open,
        retainedUncertainEffect: true,
      })).assertNewAdmissionAllowed(admissionRequest)
    ).rejects.toMatchObject({ code: 'LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED' })
    await expect(
      createLegacyAdmissionGuard(() => ({
        ...open,
        retainedUncertainEffect: false,
      })).assertNewAdmissionAllowed(admissionRequest)
    ).resolves.toBeUndefined()
    const evaluated = []
    await createLegacyAdmissionGuard((seen) => {
      evaluated.push(seen)
      return open
    }).assertNewAdmissionAllowed(admissionRequest)
    expect(evaluated).toEqual([admissionRequest])
  })

  test('the graph route marker matches the controller decorator path and version', async () => {
    const source = await readFile(
      new URL(
        '../../../apps/control-api/src/graphs/graph-administration.controller.ts',
        import.meta.url
      ),
      'utf8'
    )
    expect(source).toContain(
      `@Controller({ path: '${LEGACY_GRAPH_API.path}', version: '${LEGACY_GRAPH_API.version}' })`
    )
  })
})

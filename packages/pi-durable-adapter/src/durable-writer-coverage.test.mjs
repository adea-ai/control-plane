// The writer coverage of the durable Pi state, and the limit of what it proves.
//
// The native cancellation boundary states its own limit: matching installation
// evidence "never proves canonical R, drain D or complete writer coverage".
// This file enumerates the writers of the durable state from the source and
// records, per writer, what authority it actually holds.
//
// The enumeration is repo-wide. It is derived from three source shapes, so a
// store that starts writing durable state is classified rather than missed: a
// direct durable write or an exported durable store/owner seam in this
// package, a direct durable write to a `pi_`/`cp_pi_` table anywhere in the
// workspace, and a write through an injected durable-journal seam.
//
// It proves three things.
//
//   1. Tamper consistency. A digest binds the fields it covers, so a body that
//      is changed while its digest is retained is refused.
//
//   2. That tamper consistency is not restore authority. A rollback that
//      restores the generation AND a digest computed over the rolled-back
//      generation is internally consistent, and the pure contracts accept it.
//      The regression below asserts that acceptance as the observed behaviour,
//      so the limit is recorded rather than papered over.
//
//   3. That each writer refuses a rewound epoch where the architecture gives
//      it one, and that the writers with no epoch are not thereby proven.
//
// The writers with no independent generation authority are listed explicitly.
// For them the restore-generation property is an open acceptance gap, and this
// file says so instead of narrowing the writer universe to obtain a pass.
//
// These are pure contracts plus a disposable SQLite journal. The enumeration
// reads source text only: it opens no database, starts no process and touches
// no live resource. No fixture supplies production authority, no live resource
// is touched and no effect is performed.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import {
  PiCancellationBarrierSchema,
  PiCancellationPermitSchema,
  PiCancellationRetainedIntentSchema,
  PiCancellationTargetSchema,
  assertPiCancellationIntentReplay,
  assertPiCancellationPermitSnapshot,
  piCancellationRequestDigest,
  piCancellationTargetDigest,
} from './cancellation-owner.ts'
import {
  PiNativeCancellationFenceReceiptSchema,
  PiNativeCancellationFenceRequestSchema,
  assertPiNativeCancellationFenceReceiptBinding,
  assertPiNativeCancellationReceiptBinding,
  piNativeCancellationTargetDigest,
} from './native-cancellation-boundary.ts'
import { SqliteDurableJournal } from './journal.ts'
import { SqliteDurableEffectGateStore } from './effect-gate.ts'
import { NodeSessionLease } from './lease.ts'
import { issueInferenceResumePermit, isIssuedInferenceResumePermit } from './resume-permit.ts'
import {
  createPiDurableLocalUpgradeManifest,
  verifyPiDurableLocalUpgradeManifest,
} from './upgrade-manifest.ts'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/+$/, '')
const adapterSource = 'packages/pi-durable-adapter/src'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-20T12:00:00.000Z'
const end = '2026-10-20T12:01:00.000Z'
const hash = `sha256:${'a'.repeat(64)}`

// The durable Pi state is written from more than this module. Three
// derivations build the writer universe from the source, so a store that
// starts writing durable state is classified rather than missed:
//
//   1. a direct durable write (SQL or a file write) or an exported durable
//      store/owner seam inside this package;
//   2. a direct durable write to a `pi_`/`cp_pi_` table anywhere in the
//      workspace, because the lead stores and the Cloudflare host keep their
//      own durable Pi state;
//   3. a write through an injected durable-journal seam, because a module that
//      mutates the journal it was handed writes durable state without any SQL
//      of its own.
//
// The derivation reads source text only. It opens no database, starts no
// process and touches no live resource.
const durableTableWrite = /(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM)\s+(?:cp_)?pi_[a-z_]+/
const durableJournalMutation =
  /\.(?:admit|claim|claimProcess|transition|transitionCurrent|update|updateCurrentMetadata|updateUnderProcessClaim|releaseRecoveryClaim|releaseRecoveryDenial|releaseProcess|sessionCreate|sessionUpdate)\(/
const durableStoreSeam =
  /export interface Durable[A-Za-z]*Store|export interface Pi[A-Za-z]*(?:Owner|Boundary)Port/
const durableFileWrite = /writeFileSync|fsyncSync|INSERT INTO|INSERT OR IGNORE|UPDATE pi_/
// Test files and test fixtures are named by convention; they are excluded
// from the production writer universe and asserted separately.
const testSupportName = /\.(?:test|fixture)\.(?:ts|mjs)$|-fixture\.(?:ts|mjs)$/

function sourceFiles(root) {
  const found = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!/\.(?:ts|mjs)$/.test(entry.name)) continue
      if (testSupportName.test(entry.name)) continue
      found.push(path)
    }
  }
  return found
}

function workspaceSourceFiles() {
  const found = []
  for (const kind of ['packages', 'apps']) {
    for (const entry of readdirSync(join(workspaceRoot, kind), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = join(workspaceRoot, kind, entry.name, 'src')
      if (!existsSync(source)) continue
      for (const path of sourceFiles(source)) found.push(path.slice(workspaceRoot.length + 1))
    }
  }
  return found.toSorted()
}

// What each named module actually holds. The classification is the authority
// a writer really has, never a claim that it holds everything.
const generationHolders = new Set([
  `${adapterSource}/cancellation-owner.ts`,
  `${adapterSource}/native-cancellation-boundary.ts`,
])
const ownEpochOrIdentity = new Set([
  `${adapterSource}/cancellation-registration.ts`,
  `${adapterSource}/effect-gate.ts`,
  `${adapterSource}/journal.ts`,
  `${adapterSource}/lease.ts`,
  'packages/pi-cloudflare-host/src/owner.ts',
])
const ownRecordOnly = new Set([
  `${adapterSource}/adapter.ts`,
  `${adapterSource}/cancellation-history.ts`,
  'apps/control-api/src/models/production-lead-product.ts',
  'apps/control-api/src/models/production-role-selection.ts',
  'apps/control-api/src/models/production-source-lead-product.ts',
  'apps/control-api/src/pi-durable/lead-fence-live-harness.mjs',
  'apps/control-api/src/pi-durable/lead-preparation.ts',
  'apps/control-api/src/pi-durable/lead-running-lifecycle.ts',
  'apps/control-api/src/pi-durable/management-governed-call.ts',
  'apps/control-api/src/pi-durable/node-admission.ts',
  'apps/control-api/src/pi-durable/pi-durable-lead.service.ts',
  'packages/pi-cloudflare-host/src/sessions.ts',
])
const readersOrInProcessIdentities = new Set([
  `${adapterSource}/restore-generation-authority.ts`,
  `${adapterSource}/resume-permit.ts`,
  `${adapterSource}/upgrade-manifest.ts`,
])
const classified = new Set([
  ...generationHolders,
  ...ownEpochOrIdentity,
  ...ownRecordOnly,
  ...readersOrInProcessIdentities,
])

function fixture() {
  const target = PiCancellationTargetSchema.parse({
    workspaceId: id('wsp'),
    productIntentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
    originalActorPrincipalId: 'user:original',
    servicePrincipalId: 'svc:adea',
    scopeRef: 'adea:workspace',
    executionId: id('exe'),
    attemptId: id('att'),
    executionVersion: 2,
    attemptVersion: 3,
    admissionDigest: hash,
    handle: {
      handleId: 'pi-handle',
      attemptId: id('att'),
      startedAt: at,
      externalSessionId: id('ses'),
    },
    restoreGeneration: 'restore:fixture:1',
    ownerEpoch: 4,
    turnKey: 'turn:initial',
    targetKind: 'active_generation',
    generation: { inferenceId: 'native:1', inferenceKey: 'turn:initial:native:1' },
    authorityExpiresAt: end,
  })
  const body = { target, requestedAt: at, idempotencyKey: 'cancel:one' }
  const intent = {
    ...body,
    schemaVersion: 'pi-cancellation-retained-intent/v1',
    requestDigest: piCancellationRequestDigest(body),
  }
  const permit = {
    schemaVersion: 'pi-cancellation-revocable-permit/v1',
    permitId: 'permit:one',
    requestDigest: intent.requestDigest,
    targetDigest: piCancellationTargetDigest(target),
    fenceEpoch: 7,
    issuedAt: at,
    expiresAt: end,
  }
  const current = {
    schemaVersion: 'pi-cancellation-current-fence/v1',
    target,
    requestDigest: intent.requestDigest,
    permitId: permit.permitId,
    fenceEpoch: 7,
    fenceState: 'open',
    permitState: 'active',
  }
  const candidate = {
    target,
    nativeSessionId: target.handle.externalSessionId,
    conversationId: 1,
    scopeRevision: 3,
    taskRevisionDigest: hash,
    inputRevisionDigest: hash,
    processClaimId: 'process:one',
  }
  const preparation = {
    schemaVersion: 'pi-native-cancellation-preparation/v1',
    preparationId: 'prepare:one',
    requestDigest: intent.requestDigest,
    candidate,
    preparedAt: at,
  }
  const receipt = {
    schemaVersion: 'pi-native-cancellation-commit-receipt/v1',
    nativeReceiptId: 'native:receipt:one',
    requestDigest: intent.requestDigest,
    nativeTargetDigest: piNativeCancellationTargetDigest(candidate),
    processClaimId: candidate.processClaimId,
    restoreGeneration: target.restoreGeneration,
    ownerEpoch: target.ownerEpoch,
    nativeCommitSequence: 8,
    admittedAt: at,
    committedAt: at,
    earliestAuthorityExpiresAt: end,
    outcome: 'committed_effect',
  }
  const fence = {
    mutationId: 'mutation:one',
    scopeSetDigest: hash,
    closureGeneration: 'closure:one',
    processClaimId: candidate.processClaimId,
    restoreGeneration: target.restoreGeneration,
    ownerEpoch: target.ownerEpoch,
    previousEpoch: 4,
    fenceEpoch: 5,
  }
  return { target, body, intent, permit, current, candidate, preparation, receipt, fence }
}

test('a changed body that retains its old digest is refused: the digest binds what it covers', () => {
  const f = fixture()
  // The generation is changed while the retained digest is kept.
  const tampered = { ...f.target, restoreGeneration: 'restore:fixture:0' }
  const replay = PiCancellationRetainedIntentSchema.safeParse({ ...f.intent, target: tampered })
  expect(replay.success).toBe(false)
  expect(JSON.stringify(replay.error)).toContain('request digest mismatch')

  // The idempotency check is a different check from the schema's digest
  // binding: two bodies that are each internally consistent but differ are an
  // idempotency conflict.
  const other = {
    ...f.target,
    turnKey: 'turn:other',
    generation: { inferenceId: 'native:2', inferenceKey: 'turn:other:native:2' },
  }
  const otherBody = {
    target: other,
    requestedAt: f.body.requestedAt,
    idempotencyKey: 'cancel:other',
  }
  const otherIntent = {
    ...otherBody,
    schemaVersion: 'pi-cancellation-retained-intent/v1',
    requestDigest: piCancellationRequestDigest(otherBody),
  }
  expect(() => assertPiCancellationIntentReplay(f.intent, otherIntent)).toThrow(
    /PI_CANCELLATION_IDEMPOTENCY_CONFLICT/
  )
})

test('a rollback of the generation together with a matching digest is NOT refused by the pure contracts', () => {
  // This is the boundary the previous qualification overstated. The digest is
  // computed over the body, so a rollback that restores the generation AND
  // recomputes the digest over the rolled-back generation is internally
  // consistent. Nothing in these pure contracts holds an independent
  // generation authority, so they accept it.
  const f = fixture()
  const rolledBackTarget = { ...f.target, restoreGeneration: 'restore:fixture:0' }
  const rolledBackBody = {
    target: rolledBackTarget,
    requestedAt: f.body.requestedAt,
    idempotencyKey: f.body.idempotencyKey,
  }
  const rolledBackDigest = piCancellationRequestDigest(rolledBackBody)

  // The digest matches the rolled-back body, so the schema accepts it.
  const accepted = PiCancellationRetainedIntentSchema.safeParse({
    ...rolledBackBody,
    schemaVersion: 'pi-cancellation-retained-intent/v1',
    requestDigest: rolledBackDigest,
  })
  expect(accepted.success).toBe(true)

  // A permit over the same rolled-back generation is accepted too, because the
  // permit binds the digest of the rolled-back target.
  const rolledBackTargetDigest = piCancellationTargetDigest(rolledBackTarget)
  const permit = PiCancellationPermitSchema.safeParse({
    schemaVersion: 'pi-cancellation-revocable-permit/v1',
    permitId: 'permit:rolled-back',
    requestDigest: rolledBackDigest,
    targetDigest: rolledBackTargetDigest,
    fenceEpoch: 7,
    issuedAt: at,
    expiresAt: end,
  })
  expect(permit.success).toBe(true)

  // And the permit snapshot accepts it when the current fence agrees with the
  // same rolled-back generation. The pure contracts cannot distinguish this
  // from a genuine request.
  const current = {
    schemaVersion: 'pi-cancellation-current-fence/v1',
    target: rolledBackTarget,
    requestDigest: rolledBackDigest,
    permitId: 'permit:rolled-back',
    fenceEpoch: 7,
    fenceState: 'open',
    permitState: 'active',
  }
  // The intended binding properties are what make the snapshot acceptable:
  // every digest the permit snapshot compares is equal for the rolled-back
  // body, so the equality check cannot detect the rollback.
  expect(permit.data?.targetDigest).toBe(piCancellationTargetDigest(current.target))
  expect(permit.data?.requestDigest).toBe(current.requestDigest)
  expect(current.fenceEpoch).toBe(permit.data?.fenceEpoch)
  expect(() =>
    assertPiCancellationPermitSnapshot(
      {
        ...rolledBackBody,
        schemaVersion: 'pi-cancellation-retained-intent/v1',
        requestDigest: rolledBackDigest,
      },
      permit.data,
      current,
      at
    )
  ).not.toThrow()

  // The native receipt binding accepts the same rolled-back generation too,
  // because the receipt carries the intent's own generation.
  const candidate = { ...f.candidate, target: rolledBackTarget }
  const preparation = {
    ...f.preparation,
    requestDigest: rolledBackDigest,
    candidate,
  }
  const receipt = {
    ...f.receipt,
    requestDigest: rolledBackDigest,
    nativeTargetDigest: piNativeCancellationTargetDigest(candidate),
    restoreGeneration: rolledBackTarget.restoreGeneration,
  }
  // The intended binding properties again: the receipt's generation equals the
  // intent's generation, and the native target digest equals the candidate's.
  expect(receipt.restoreGeneration).toBe(rolledBackTarget.restoreGeneration)
  expect(receipt.nativeTargetDigest).toBe(piNativeCancellationTargetDigest(candidate))
  expect(() =>
    assertPiNativeCancellationReceiptBinding(
      {
        ...rolledBackBody,
        schemaVersion: 'pi-cancellation-retained-intent/v1',
        requestDigest: rolledBackDigest,
      },
      preparation,
      receipt
    )
  ).not.toThrow()
})

test('a writer that holds an epoch refuses a rewound epoch', () => {
  const f = fixture()

  // The cancellation owner: a barrier that does not advance the epoch is not a
  // barrier, and a permit whose fence epoch is behind the current one proves
  // nothing.
  const barrier = PiCancellationBarrierSchema.safeParse({
    schemaVersion: 'pi-cancellation-barrier/v1',
    barrierId: 'barrier:one',
    targetDigest: f.permit.targetDigest,
    ownerEpoch: f.target.ownerEpoch,
    previousEpoch: 7,
    fenceEpoch: 7,
    requestedAt: at,
    state: 'pending',
  })
  expect(barrier.success).toBe(false)
  expect(JSON.stringify(barrier.error)).toContain('barrier epoch must advance')
  expect(() =>
    assertPiCancellationPermitSnapshot(f.intent, f.permit, { ...f.current, fenceEpoch: 9 }, at)
  ).toThrow(/PI_CANCELLATION_AUTHORITY_REJECTED/)

  // The native boundary: the fence request must advance the epoch.
  const fence = PiNativeCancellationFenceRequestSchema.safeParse({
    ...f.fence,
    previousEpoch: 5,
    fenceEpoch: 5,
  })
  expect(fence.success).toBe(false)
  expect(JSON.stringify(fence.error)).toContain('native fence epoch must advance')
})

test('the native fence receipt is bound to the exact request it answers', () => {
  const f = fixture()
  const receipt = PiNativeCancellationFenceReceiptSchema.safeParse({
    ...f.fence,
    schemaVersion: 'pi-native-cancellation-fence-receipt/v1',
    installationReceiptId: 'installation:one',
    nativeCommitSequence: 9,
    installedAt: at,
  })
  expect(receipt.success).toBe(true)
  expect(receipt.data?.restoreGeneration).toBe(f.fence.restoreGeneration)
  expect(receipt.data?.fenceEpoch).toBe(f.fence.fenceEpoch)

  // A receipt that carries a different restore generation is not the receipt
  // for this request.
  expect(() =>
    assertPiNativeCancellationFenceReceiptBinding(f.fence, {
      ...receipt.data,
      restoreGeneration: 'restore:fixture:0',
    })
  ).toThrow(/PI_NATIVE_CANCELLATION_FENCE_RECEIPT_MISMATCH/)
})

test('the native commit receipt is bound to the exact generation of its intent', () => {
  const f = fixture()
  expect(() =>
    assertPiNativeCancellationReceiptBinding(f.intent, f.preparation, {
      ...f.receipt,
      restoreGeneration: 'restore:fixture:0',
    })
  ).toThrow(/PI_NATIVE_CANCELLATION_RECEIPT_MISMATCH/)
})

test('the journal refuses a rewound epoch and a superseded owner claim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-journal-writer-'))
  try {
    const journal = new SqliteDurableJournal(join(directory, 'authority.sqlite'))
    const record = journal.admit({
      handleId: 'handle-one',
      attemptId: id('att'),
      startKey: 'journal-writer-one',
      admission: { selectionRef: 'opaque' },
      at,
    })
    const epoch = journal.claim(record.handleId)

    // A claim that expects the pre-claim epoch is refused: the record moved on.
    expect(() =>
      journal.claim(record.handleId, { epoch: record.epoch, state: record.state })
    ).toThrow(/STALE_STATE/)

    // A transition that expects the pre-claim record is refused for the same
    // reason.
    expect(() => journal.transition(record, () => ({ change: { state: 'done' } }))).toThrow(
      /STALE_STATE/
    )

    // The epoch the journal handed out is the one it advanced to, so a caller
    // cannot rewind it by reusing the earlier value.
    expect(epoch).toBe(record.epoch + 1)
    expect(journal.get(record.handleId).epoch).toBe(epoch)

    // A process claim records the owner epoch, and a superseded claim does not
    // hold the record afterwards.
    const claim = journal.claimProcess(record.handleId)
    expect(claim.ownerEpoch).toBe(epoch + 1)
    expect(journal.holdsProcessClaim(record.handleId, claim)).toBe(true)
    journal.releaseRecoveryClaim(record.handleId, claim)
    expect(journal.holdsProcessClaim(record.handleId, claim)).toBe(false)
    journal.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the effect gate store refuses a compare-and-set against a superseded revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-effect-gate-writer-'))
  try {
    const database = new DatabaseSync(join(directory, 'authority.sqlite'))
    const store = new SqliteDurableEffectGateStore(database)
    const record = {
      schemaVersion: 'pi-effect-gate/v1',
      key: 'effect-writer-one',
      requestDigest: hash,
      toolRequestDigest: hash,
      toolCallId: id('tlc'),
      revision: 1,
      state: 'invoking',
    }
    expect(await store.insert(record)).toBe(true)
    // The same key is not inserted twice.
    expect(await store.insert(record)).toBe(false)

    // A compare-and-set against the current revision advances it.
    expect(
      await store.compareAndSet(1, { ...record, revision: 2, state: 'awaiting_approval' })
    ).toBe(true)
    // A compare-and-set against the superseded revision is refused: the writer
    // cannot rewind the revision it already advanced.
    expect(await store.compareAndSet(1, { ...record, revision: 3, state: 'settled' })).toBe(false)
    // The stored record is the one the successful compare-and-set wrote.
    const stored = await store.get('effect-writer-one')
    expect(stored?.revision).toBe(2)
    expect(stored?.state).toBe('awaiting_approval')
    database.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the session lease refuses a second owner while the first holds it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lease-writer-'))
  try {
    const lease = new NodeSessionLease(directory, 'session-one')
    // A second owner for the same session is refused while the first holds it.
    expect(() => new NodeSessionLease(directory, 'session-one')).toThrow(/PI_SESSION_OWNER_ACTIVE/)
    // The holder can release.
    lease.release()
    // And after the release a new owner is admitted.
    const next = new NodeSessionLease(directory, 'session-one')
    next.release()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the resume permit is identity-bound, not shape-bound', () => {
  const permit = issueInferenceResumePermit('turn:initial:native:1')
  expect(isIssuedInferenceResumePermit(permit, 'turn:initial:native:1')).toBe(true)
  // The same permit is not valid for a different inference key.
  expect(isIssuedInferenceResumePermit(permit, 'turn:initial:native:2')).toBe(false)
  // A structurally identical literal was never issued and does not pass.
  expect(
    isIssuedInferenceResumePermit(
      { schemaVersion: 'pi-inference-resume-permit/v1', inferenceKey: 'turn:initial:native:1' },
      'turn:initial:native:1'
    )
  ).toBe(false)
})

test('the upgrade manifest detects a rolled-back store by byte identity', async () => {
  // The manifest is a reader, not a writer, but it does hold one authority:
  // it records the exact bytes of the store, so a store that was rolled back
  // to an earlier state is detected when the manifest is verified against it.
  // It grants no execution or restore authority by its own contract, so this
  // is byte identity and not a generation.
  const directory = mkdtempSync(join(tmpdir(), 'pi-upgrade-manifest-writer-'))
  try {
    writeFileSync(join(directory, 'authority.sqlite'), 'store-bytes-one')
    const manifest = await createPiDurableLocalUpgradeManifest(directory)
    expect(manifest.files).toHaveLength(1)
    expect(manifest.files[0]?.path).toBe('authority.sqlite')
    expect(manifest.files[0]?.bytes).toBe('store-bytes-one'.length)

    // The unchanged store verifies.
    await expect(verifyPiDurableLocalUpgradeManifest(directory, manifest)).resolves.toBeUndefined()

    // A store that was rolled back to different bytes is refused.
    writeFileSync(join(directory, 'authority.sqlite'), 'store-bytes-two')
    await expect(verifyPiDurableLocalUpgradeManifest(directory, manifest)).rejects.toThrow(
      /PI_UPGRADE_STORE_MANIFEST_MISMATCH/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the writers with no generation authority are named, and the gap stays open', () => {
  // These writers of the durable state do not carry a restore generation or an
  // independent epoch that could refuse a rolled-back generation:
  //
  //   - the effect gate store keys its record by the request and advances a
  //     revision, but the revision is local to the gate, not a generation;
  //   - the journal owns an epoch, but it is the journal's own epoch over its
  //     own record, not a restore generation;
  //   - the session lease owns a process identity on the host, not a
  //     generation;
  //   - the Cloudflare host owner owns an owner epoch over its own durable
  //     object storage, which is the storage a restore would replace;
  //   - the adapter writes the journal's own records and its prepared/armed
  //     receipts; those receipts are monotonic within one record and are not
  //     a restore generation;
  //   - the cancellation history classifier writes history metadata through
  //     the journal it was handed, so it writes durable state without any SQL
  //     of its own;
  //   - the lead admission, preparation, running-lifecycle, management-call
  //     and lead-receipt stores bind a digest, a revision or a record
  //     condition over their own rows;
  //   - the production selection stores bind their own selection rows;
  //   - the Cloudflare session store holds a session body;
  //   - the shared live fence harness writes durable Pi state only while it
  //     drives the production composition inside a test;
  //   - the upgrade manifest reads the store and produces a digest of it, and
  //     grants no restore authority by its own contract;
  //   - the resume permit is an in-process identity and is not exported from
  //     the package entry point.
  //
  // For these writers the restore-generation property is NOT proven. The
  // assertions above cover the authority each one actually holds. The
  // full-writer restore-generation acceptance therefore stays open, and the
  // previous qualification's claim of complete coverage was wrong.
  const writersWithoutGenerationAuthority = [
    ...ownEpochOrIdentity,
    ...ownRecordOnly,
    ...readersOrInProcessIdentities,
  ].toSorted()
  expect(writersWithoutGenerationAuthority).toHaveLength(20)
  expect(writersWithoutGenerationAuthority).not.toContain(`${adapterSource}/cancellation-owner.ts`)
  expect(writersWithoutGenerationAuthority).not.toContain(
    `${adapterSource}/native-cancellation-boundary.ts`
  )
})

test('every module that writes the durable state is accounted for', () => {
  // The writer universe is derived from the source, so a module that starts
  // writing the durable state without being classified here fails this file.
  // The classification is not a pass/fail of coverage: it records which
  // writer carries a restore generation and which does not.
  const universe = workspaceSourceFiles()
  const texts = new Map(
    universe.map((path) => [path, readFileSync(join(workspaceRoot, path), 'utf8')])
  )

  // A module writes the durable state when it performs a durable write itself,
  // exposes a store/owner seam that another caller writes through, or mutates
  // the durable journal it was handed.
  const packageLocal = universe.filter(
    (path) =>
      path.startsWith(`${adapterSource}/`) &&
      (durableFileWrite.test(texts.get(path)) || durableStoreSeam.test(texts.get(path)))
  )
  const durableTableWriters = universe.filter((path) => durableTableWrite.test(texts.get(path)))
  const journalSeamWriters = universe.filter(
    (path) =>
      texts.get(path).includes('SqliteDurableJournal') &&
      durableJournalMutation.test(texts.get(path))
  )

  const writers = [
    ...new Set([...packageLocal, ...durableTableWriters, ...journalSeamWriters]),
  ].toSorted()

  // Every one of these is classified below. The classification is what each
  // writer actually holds, not a claim that it holds everything.
  expect(writers).toEqual([
    'apps/control-api/src/models/production-lead-product.ts',
    'apps/control-api/src/models/production-role-selection.ts',
    'apps/control-api/src/models/production-source-lead-product.ts',
    'apps/control-api/src/pi-durable/lead-fence-live-harness.mjs',
    'apps/control-api/src/pi-durable/lead-preparation.ts',
    'apps/control-api/src/pi-durable/lead-running-lifecycle.ts',
    'apps/control-api/src/pi-durable/management-governed-call.ts',
    'apps/control-api/src/pi-durable/node-admission.ts',
    'apps/control-api/src/pi-durable/pi-durable-lead.service.ts',
    'packages/pi-cloudflare-host/src/owner.ts',
    'packages/pi-cloudflare-host/src/sessions.ts',
    'packages/pi-durable-adapter/src/adapter.ts',
    'packages/pi-durable-adapter/src/cancellation-history.ts',
    'packages/pi-durable-adapter/src/cancellation-owner.ts',
    'packages/pi-durable-adapter/src/cancellation-registration.ts',
    'packages/pi-durable-adapter/src/effect-gate.ts',
    'packages/pi-durable-adapter/src/journal.ts',
    'packages/pi-durable-adapter/src/lease.ts',
    'packages/pi-durable-adapter/src/native-cancellation-boundary.ts',
  ])

  for (const writer of writers) expect(classified.has(writer)).toBe(true)

  // The writers that carry a restore generation are the two whose target binds
  // it. Every other writer is accounted for under one of the other
  // classifications, and none of them is claimed to refuse a rolled-back
  // generation through qualified production authority. The dormant registration
  // prototype reads injected generation evidence, but provides no such authority.
  expect(generationHolders.size).toBe(2)
  expect(writers.filter((writer) => generationHolders.has(writer)).toSorted()).toEqual([
    `${adapterSource}/cancellation-owner.ts`,
    `${adapterSource}/native-cancellation-boundary.ts`,
  ])

  // The derivation is not vacuous: it reaches durable stores outside this
  // package, and it finds the seam writers that write no SQL of their own.
  expect(writers.some((writer) => !writer.startsWith(`${adapterSource}/`))).toBe(true)
  expect(journalSeamWriters).toEqual([
    `${adapterSource}/adapter.ts`,
    `${adapterSource}/cancellation-history.ts`,
  ])

  // The upgrade manifest is a reader: it must not appear as a durable writer,
  // because its own contract grants no restore authority.
  expect(durableTableWriters).not.toContain(`${adapterSource}/upgrade-manifest.ts`)
  expect(writers).not.toContain(`${adapterSource}/upgrade-manifest.ts`)
})

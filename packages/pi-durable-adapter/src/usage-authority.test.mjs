import { expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPiDurableUsageAuthority } from './usage-authority.ts'
import { issueInferenceResumePermit } from './resume-permit.ts'
import { withUsageAuthorityContext, at, ids } from './usage-authority.fixture.mjs'
import { createSubprocessFixtureProbe } from './subprocess-fixture-data.fixture.mjs'

test('durable dispatch reserves full input and fences a duplicate across SQLite reopen', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority, ledger, workspaceId, reopen }) => {
    const key = 'pi-turn:one:pi-generation:2'
    expect(await bridge.authorizeInference(authority, key)).toMatchObject({
      maxOutputTokens: 32,
      maximumInputTokens: 64,
    })
    const holds = (await ledger.entries(workspaceId, ids.executionId)).filter(
      (entry) => entry.kind === 'model_reservation'
    )
    expect(holds[0].reservedTokens).toBe(96)
    expect(holds[0].costMicrounits).toBe(128)
    const { bridge: reopened } = await reopen()
    await expect(reopened.authorizeInference(authority, key)).rejects.toThrow(
      'MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED'
    )
  })
})

test('only a trusted exact-key no-send permit can reuse a held dispatch', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority, workspaceId, reopen }) => {
    const key = 'pi-turn:one:pi-generation:2'
    await bridge.authorizeInference(authority, key)
    const { bridge: recovered, ledger } = await reopen()
    const before = await ledger.entries(workspaceId, ids.executionId)
    await expect(
      recovered.authorizeInference(authority, key, issueInferenceResumePermit('different-key'))
    ).rejects.toThrow('PI_INFERENCE_RESUME_PERMIT_INVALID')
    for (const forged of [
      { schemaVersion: 'pi-inference-resume-permit/v1', inferenceKey: key },
      Object.freeze({ schemaVersion: 'pi-inference-resume-permit/v1', inferenceKey: key }),
      structuredClone(issueInferenceResumePermit(key)),
    ])
      await expect(recovered.authorizeInference(authority, key, forged)).rejects.toThrow(
        'PI_INFERENCE_RESUME_PERMIT_INVALID'
      )
    expect(
      await recovered.authorizeInference(authority, key, issueInferenceResumePermit(key))
    ).toMatchObject({
      maxOutputTokens: 32,
      maximumInputTokens: 64,
    })
    expect(await ledger.entries(workspaceId, ids.executionId)).toEqual(before)
    await expect(recovered.authorizeInference(authority, key)).rejects.toThrow(
      'MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED'
    )
  })
})

test('another process cannot redispatch an admitted native generation', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority, directory, path, priceSnapshot }) => {
    const key = 'pi-turn:one:pi-generation:2'
    const probe = createSubprocessFixtureProbe()
    authority.admission.prompt = probe
    await bridge.authorizeInference(authority, key)
    const inputPath = join(directory, 'dispatch-replay-input.json')
    await writeFile(inputPath, JSON.stringify({ at, authority, key, path, priceSnapshot, probe }), {
      mode: 0o600,
    })
    const childFixture = fileURLToPath(
      new URL('./usage-authority-dispatch-replay.child.mjs', import.meta.url)
    )
    const worker = Bun.spawn([process.execPath, childFixture, inputPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const output = await new Response(worker.stdout).text()
      const error = await new Response(worker.stderr).text()
      expect(await worker.exited, error).toBe(0)
      expect(JSON.parse(output)).toEqual({
        status: 'MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED',
        probe,
        admissionPrompt: probe,
      })
    } finally {
      worker.kill()
      await worker.exited
    }
  })
}, 15000)

test('settlement uses the same inference key, pinned rates and trusted cached counts after reopen', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority, reopen, workspaceId }) => {
    const key = 'pi-turn:one:pi-generation:2'
    await bridge.authorizeInference(authority, key)
    const { bridge: reopened, ledger } = await reopen()
    const usage = {
      inputTokens: 20,
      outputTokens: 10,
      durationMs: 3,
      cost: { amount: '99999999', currency: 'USD' },
    }
    const counters = { cachedInputTokens: 10, reasoningTokens: 2 }
    const receipt = await reopened.settleUsage(authority, key, usage, counters)
    expect(receipt.accounting.chargedMicrounits).toBe(35)
    expect(receipt.cost.amount).toBe('0.000035')
    expect(await reopened.settleUsage(authority, key, usage, counters)).toEqual(receipt)
    expect(
      (await ledger.entries(workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'model_usage'
      )
    ).toHaveLength(1)
    await expect(reopened.settleUsage(authority, 'pi-turn:one', usage, counters)).rejects.toThrow(
      'PI_INFERENCE_RESERVATION_NOT_FOUND'
    )
    await expect(
      reopened.settleUsage(authority, key, { ...usage, outputTokens: 11 }, counters)
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    expect(
      await reopened.authorizeInference(authority, 'pi-turn:two:pi-generation:3')
    ).toMatchObject({
      maxOutputTokens: 6,
      maximumInputTokens: 64,
    })
  })
})

test('scope mismatch and insufficient conservative input fail before dispatch', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority }) => {
    await expect(
      bridge.authorizeInference(
        {
          ...authority,
          request: { ...authority.request, attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
        },
        'pi-turn:one:pi-generation:2'
      )
    ).rejects.toThrow('PI_USAGE_AUTHORITY_INVALID')
    await expect(
      bridge.authorizeInference(
        {
          ...authority,
          request: {
            ...authority.request,
            attemptBudget: { ...authority.request.attemptBudget, maximumTokens: 64 },
          },
        },
        'pi-turn:one:pi-generation:2'
      )
    ).rejects.toThrow('PI_CONSERVATIVE_INPUT_BUDGET_EXHAUSTED')
  })
})

test('funded attempt cannot dispatch without separate active spending evidence', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority, ledger, workspaceId, spending }) => {
    spending.reject = true
    await expect(
      bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
    ).rejects.toThrow('SPENDING_NOT_AUTHORIZED')
    spending.reject = false
    spending.active = false
    await expect(
      bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
    ).rejects.toThrow('SPENDING_REVOKED')
    expect(
      (await ledger.entries(workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'model_reservation'
      )
    ).toHaveLength(0)
    expect(spending.requests[0]).toMatchObject({
      attemptMaximumMicrounits: 1000,
      attemptMaximumTokens: 100,
      maximumMicrounits: 128,
      maximumTokens: 96,
    })
    expect(spending.requests[0].priceSnapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})

test('spending revocation after reservation is rechecked and holds cannot settle under replacement evidence', async () => {
  await withUsageAuthorityContext(async ({ bridge, authority, spending, reopen }) => {
    const key = 'pi-turn:one:pi-generation:2'
    const allowance = await bridge.authorizeInference(authority, key)
    expect(spending.assertions).toBe(2)
    spending.active = false
    await expect(allowance.assertActive()).rejects.toThrow('SPENDING_REVOKED')
    spending.active = true
    spending.evidenceDigest = `sha256:${'f'.repeat(64)}`
    const { bridge: reopened } = await reopen()
    await expect(reopened.authorizeInference(authority, key)).rejects.toThrow(
      'PI_PINNED_PRICE_HOLD_MISMATCH'
    )
    await expect(
      reopened.settleUsage(authority, key, { inputTokens: 20, outputTokens: 10, durationMs: 1 })
    ).rejects.toThrow('PI_PINNED_PRICE_HOLD_MISMATCH')
  })
})

test('missing or malformed recorded spending port fails closed', async () => {
  expect(() =>
    createPiDurableUsageAuthority({ ledger: {}, resolvePrice: async () => ({}) })
  ).toThrow('PI_MODEL_SPENDING_AUTHORITY_REQUIRED')
  await withUsageAuthorityContext(async ({ bridge, authority, spending }) => {
    spending.evidenceDigest = 'secret=credential'
    await expect(
      bridge.authorizeInference(authority, 'pi-turn:one:pi-generation:2')
    ).rejects.toThrow('PI_MODEL_SPENDING_AUTHORIZATION_INVALID')
  })
})

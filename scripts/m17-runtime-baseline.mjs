/**
 * M17.01 (adea-ai/control-plane#941) runtime ownership baseline measurement.
 *
 * Probe state is temp-only: every probe writes only inside a fresh
 * `os.tmpdir()` directory that is removed before the report is emitted. The
 * report itself goes to stdout or, with `--out`, to that explicit path (which
 * may be inside the repository). Failure reasons are bounded reason codes;
 * raw exception text, child stdout/stderr, and ambient environment values are
 * never copied into the report. No credentials and no network: the Local
 * embedded-SQLite path is exercised only on disposable temp files.
 *
 * Usage:
 *   bun scripts/m17-runtime-baseline.mjs [--out <file>]
 *
 * The emitted report is a candidate measurement of THIS RUN only. It asserts
 * nothing about whether any baseline exists elsewhere in the repository or
 * history; acceptance is a separate, explicitly dated review act.
 *
 * Tuning (all bounded, validated):
 *   M17_QUEUE_ITERATIONS    enqueue/claim/complete rounds   (default 50, 1..5000)
 *   M17_OBJECT_ITERATIONS   object put/get rounds           (default 50, 1..5000)
 *   M17_LEDGER_ITERATIONS   durable usage reserve rounds    (default 50, 1..5000)
 *   M17_POLICY_ITERATIONS   in-process authorize rounds     (default 200, 1..20000)
 *   M17_IMPORT_PROBES       1/0 per-layer import+RSS probes (default 1)
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

import {
  SqliteDurableUsageStore,
  SqlitePersistenceProvider,
} from '../packages/sqlite-persistence/src/index.ts'
import { ExecutionAttemptSchema, ExecutionSchema } from '../packages/domain/src/index.ts'
import { WorkflowJobStore } from '../packages/workflow-runtime/src/embedded-job-store.ts'
import { FilesystemObjectStore } from '../packages/object-store/src/filesystem.ts'
import { DurableUsageLedger } from '../packages/usage-ledger/src/durable.ts'
import {
  CedarPolicyDecisionPoint,
  FakeCedarEvaluator,
  InMemoryPolicyStore,
} from '../packages/policy/src/index.ts'
import {
  COUPLING_METHOD,
  SOURCE_FILE_PATTERN,
  TEST_FILE_PATTERN,
  classifyImportProbeChild,
  measureCoupling,
  safeFailureReason,
} from '../packages/production-readiness/src/runtime-baseline-analysis.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

const ITERATION_BOUNDS = {
  queue: [1, 5000],
  object: [1, 5000],
  ledger: [1, 5000],
  policy: [1, 20000],
}
const ITERATION_DEFAULTS = { queue: 50, object: 50, ledger: 50, policy: 200 }

/**
 * Measurement groups for the #941 keep/replace/retire map. `include` paths are
 * repository-relative files or directories; `exclude` subtracts files that a
 * different layer owns, so every repository file belongs to at most one group
 * (verified by `assertDisjointLayers`). `importProbe` names the source entry
 * used for the cold-import time + RSS-delta probe.
 */
export const M17_LAYERS = [
  {
    id: 'custom-runtime',
    title: 'Custom lifecycle/hosted runtime (embedded workflow engine, runtime workers)',
    include: [
      'packages/workflow-runtime/src',
      'packages/runtime-sdk/src',
      'apps/workflow-worker/src',
      'apps/runtime-worker/src',
    ],
    exclude: [
      'packages/workflow-runtime/src/restate-endpoint.ts',
      'packages/runtime-sdk/src/transport.ts',
      'apps/workflow-worker/src/restate-worker.ts',
      'apps/runtime-worker/src/hosted-managed-pi-artifact-stores.ts',
    ],
    importProbe: 'packages/workflow-runtime/src/embedded-runtime.ts',
  },
  {
    id: 'restate',
    title: 'Restate durable execution layer (hosted/local-restate profiles only)',
    include: [
      'packages/restate-runtime/src',
      'packages/workflow-runtime/src/restate-endpoint.ts',
      'apps/workflow-worker/src/restate-worker.ts',
    ],
    exclude: [],
    importProbe: 'packages/restate-runtime/src/index.ts',
  },
  {
    id: 'transports',
    title: 'Runtime transports (direct-local / remote-gateway, wire protocol, relay)',
    include: [
      'packages/runtime-sdk/src/transport.ts',
      'packages/runtime-gateway-protocol/src',
      'packages/remote-control-relay/src',
    ],
    exclude: [],
    importProbe: 'packages/runtime-gateway-protocol/src/index.ts',
  },
  {
    id: 'auth',
    title: 'Authentication and credential ownership (service/device principals, vault, secrets)',
    include: [
      'packages/contracts/src/authentication.ts',
      'packages/credential-vault/src',
      'packages/secrets/src',
      'apps/control-api/src/auth',
      'apps/local-control-plane/src/authentication.ts',
      'apps/runtime-gateway/src/authentication.ts',
    ],
    exclude: [],
    importProbe: 'packages/credential-vault/src/index.ts',
  },
  {
    id: 'policy',
    title: 'Policy decision point (Cedar PDP, decision resolution)',
    include: ['packages/policy/src'],
    exclude: [],
    importProbe: 'packages/policy/src/index.ts',
  },
  {
    id: 'billing',
    title: 'Billing/accounting (durable usage ledger, budgets)',
    include: [
      'packages/usage-ledger/src',
      'packages/database/src/usage-store.ts',
      'budgets.json',
      'scripts/check-budgets.mjs',
    ],
    exclude: [],
    importProbe: 'packages/usage-ledger/src/index.ts',
  },
  {
    id: 'artifacts',
    title: 'Artifacts (filesystem/S3-compatible object stores, artifact verification)',
    include: [
      'packages/object-store/src',
      'apps/runtime-worker/src/hosted-managed-pi-artifact-stores.ts',
      'apps/runtime-gateway/src/runtime-artifact-verifier.ts',
    ],
    exclude: [],
    importProbe: 'packages/object-store/src/index.ts',
  },
  {
    id: 'device-supervision',
    title: 'Device/RuntimeNode supervision (gateway identity, channels, process supervision)',
    include: [
      'apps/runtime-gateway/src',
      'packages/database/src/schema/runtime-connections.ts',
      'packages/deployment/src/process-runtime.ts',
      'packages/deployment/src/local-adapters.ts',
      'scripts/runtime-node-identity-admin.mjs',
      'scripts/runtime-node-identity-admin-cli.mjs',
    ],
    exclude: [
      'apps/runtime-gateway/src/authentication.ts',
      'apps/runtime-gateway/src/runtime-artifact-verifier.ts',
    ],
    importProbe: 'apps/runtime-gateway/src/runtime-node-identity-port.ts',
  },
  {
    id: 'pi-durable-node-adapter',
    title: 'Node Pi Durable adapter (candidate successor runtime, Node 24 + SQLite)',
    include: ['packages/pi-durable-adapter/src'],
    exclude: [],
    importProbe: 'packages/pi-durable-adapter/src/index.ts',
  },
  {
    id: 'pi-cloudflare-host',
    title: 'Cloudflare Pi Durable host (Durable Object, unregistered/no capabilities)',
    include: ['packages/pi-cloudflare-host/src'],
    exclude: [],
    importProbe: 'packages/pi-cloudflare-host/src/index.ts',
  },
]

/**
 * Costs and capacities that a local read-only run cannot honestly measure.
 * Every entry stays `unavailable` with a concrete reason; nothing here is
 * silently waived or estimated.
 */
export const M17_UNAVAILABLE_COSTS = [
  {
    cost: 'Restate server invocation latency and state growth (hosted profiles)',
    status: 'unavailable',
    reason:
      'Requires a running Restate server; no server is started by this read-only run. The Local profile uses embedded SQLite and has no Restate layer to measure.',
  },
  {
    cost: 'Managed-cloud operational cost (Railway, Neon, R2, Restate)',
    status: 'unavailable',
    reason: 'Requires live cloud accounts and billing data; no credentials are used or requested.',
  },
  {
    cost: 'Cloudflare Worker/Durable Object latency and cost',
    status: 'unavailable',
    reason:
      'No Worker deployment, account, or credentials; pi-cloudflare-host advertises no production capability on current main.',
  },
  {
    cost: 'Live model-provider latency and spend',
    status: 'unavailable',
    reason:
      'No provider credentials are used; live-provider qualification is out of scope for #941 tooling.',
  },
  {
    cost: 'Physical RuntimeNode device supervision health',
    status: 'unavailable',
    reason: 'No physical device or Agent HQ enrollment is attached to this developer host.',
  },
  {
    cost: 'PostgreSQL hosted-server profile latency',
    status: 'unavailable',
    reason:
      'Local PostgreSQL fixture (bun run db:up) was not started for this run; hosted-store behavior is not claimed.',
  },
  {
    cost: 'Review and acceptance handling time',
    status: 'unavailable',
    reason:
      'Not machine-measurable; recorded as an explicit non-measured cost item, not an acceptance gate.',
  },
]

const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'dist', '.git', 'coverage'])

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) return []
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return walkFiles(path)
      return [path]
    })
  )
  return nested.flat()
}

async function pathKind(path) {
  try {
    const entries = await readdir(path)
    return Array.isArray(entries) ? 'directory' : 'file'
  } catch (error) {
    if (error && error.code === 'ENOTDIR') return 'file'
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function resolveLayerFiles(layer, base) {
  const included = new Set()
  for (const target of layer.include) {
    const absolute = join(base, target)
    const kind = await pathKind(absolute)
    if (kind === 'file') {
      included.add(relative(base, absolute))
    } else if (kind === 'directory') {
      for (const file of await walkFiles(absolute)) included.add(relative(base, file))
    } else {
      throw new Error(`M17_LAYER_INCLUDE_MISSING: ${layer.id} -> ${target}`)
    }
  }
  for (const target of layer.exclude) {
    const absolute = join(base, target)
    const kind = await pathKind(absolute)
    if (kind === 'file') {
      if (!included.delete(relative(base, absolute))) {
        throw new Error(`M17_LAYER_EXCLUDE_DANGLING: ${layer.id} -> ${target}`)
      }
    } else if (kind === 'directory') {
      for (const file of await walkFiles(absolute)) included.delete(relative(base, file))
    } else {
      throw new Error(`M17_LAYER_EXCLUDE_MISSING: ${layer.id} -> ${target}`)
    }
  }
  if (included.size === 0) throw new Error(`M17_LAYER_EMPTY: ${layer.id}`)
  return [...included].toSorted()
}

function assertDisjointLayers(assignments) {
  const owner = new Map()
  for (const { id, files } of assignments) {
    for (const file of files) {
      const previous = owner.get(file)
      if (previous !== undefined && previous !== id) {
        throw new Error(`M17_LAYER_OVERLAP: ${file} in ${previous} and ${id}`)
      }
      owner.set(file, id)
    }
  }
}

const EXPORT_PATTERN =
  /^export\s+(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum|\{|\*)/gm

async function measureComplexity(files, base) {
  const complexity = {
    files: files.length,
    sourceFiles: 0,
    testFiles: 0,
    otherFiles: 0,
    sourceLines: 0,
    testLines: 0,
    exportStatements: 0,
    todoMarkers: 0,
  }
  for (const file of files) {
    if (!SOURCE_FILE_PATTERN.test(file) && !file.endsWith('.json') && !file.endsWith('.mjs')) {
      complexity.otherFiles += 1
      continue
    }
    const contents = await readFile(join(base, file), 'utf8')
    const lines = contents.split('\n').length - 1
    if (TEST_FILE_PATTERN.test(file)) {
      complexity.testFiles += 1
      complexity.testLines += lines
      continue
    }
    if (!SOURCE_FILE_PATTERN.test(file)) {
      complexity.otherFiles += 1
      continue
    }
    complexity.sourceFiles += 1
    complexity.sourceLines += lines
    complexity.exportStatements += (contents.match(EXPORT_PATTERN) ?? []).length
    complexity.todoMarkers += (contents.match(/\b(?:TODO|FIXME|XXX)\b/g) ?? []).length
  }
  return complexity
}

function percentile(values, fraction) {
  const sorted = [...values].toSorted((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(values.length * fraction) - 1)]
}

function summarize(values) {
  if (values.length === 0) return null
  return {
    samples: values.length,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values)),
    meanMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function readBound(name) {
  const bounds = ITERATION_BOUNDS[name]
  const fallback = ITERATION_DEFAULTS[name]
  const raw = process.env[`M17_${name.toUpperCase()}_ITERATIONS`]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < bounds[0] || value > bounds[1]) {
    throw new Error(`M17_ITERATION_CONFIGURATION_INVALID: ${name}=${raw}`)
  }
  return value
}

/**
 * Local embedded-SQLite durable queue round trip: enqueue -> claim -> complete
 * against a disposable temp database. This is the Local profile's own queue
 * path (WorkflowJobStore over SqlitePersistenceProvider), never the real Local
 * state directory.
 */
async function probeLocalQueue(iterations) {
  const directory = await mkdtemp(join(tmpdir(), 'm17-queue-'))
  const samples = { enqueueMs: [], claimMs: [], completeMs: [], roundTripMs: [] }
  let provider
  try {
    provider = new SqlitePersistenceProvider({ path: join(directory, 'queue.sqlite') })
    await provider.migrate()
    const store = new WorkflowJobStore(provider)
    const owner = 'm17-baseline'
    const input = {
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      deadlineAt: '2026-10-08T13:00:00.000Z',
      executionPlan: { planId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV', steps: [] },
    }
    for (let index = 0; index < iterations; index += 1) {
      const at = new Date(Date.parse('2026-10-08T12:00:00.000Z') + index).toISOString()
      const workflowKey = `m17-baseline-${index}`
      const started = performance.now()
      const enqueueStarted = performance.now()
      await store.enqueue({ workflowKey, input, at })
      samples.enqueueMs.push(performance.now() - enqueueStarted)
      const claimStarted = performance.now()
      const [claim] = await store.claimDue({ owner, leaseMs: 60_000, now: at, limit: 1 })
      samples.claimMs.push(performance.now() - claimStarted)
      if (claim === undefined) throw new Error('M17_QUEUE_CLAIM_EMPTY')
      const completeStarted = performance.now()
      const completed = await store.complete({
        workflowKey,
        owner,
        token: claim.lease.token,
        outcome: { executionId: input.executionId, status: 'completed' },
        at,
      })
      samples.completeMs.push(performance.now() - completeStarted)
      if (!completed) throw new Error('M17_QUEUE_COMPLETE_FAILED')
      samples.roundTripMs.push(performance.now() - started)
    }
    const health = await provider.health()
    if (!health.ready) throw new Error('M17_QUEUE_INTEGRITY_FAILED')
    return {
      id: 'local-embedded-sqlite-queue-round-trip',
      layer: 'custom-runtime',
      status: 'measured',
      workload:
        'WorkflowJobStore enqueue -> claimDue -> complete on disposable SQLite (Local path)',
      iterations,
      latencyMs: {
        enqueue: summarize(samples.enqueueMs),
        claim: summarize(samples.claimMs),
        complete: summarize(samples.completeMs),
        roundTrip: summarize(samples.roundTripMs),
      },
      notes: [
        'single-process developer host',
        'disposable temp database; not the Local profile state directory',
        'durable WAL/FULL SQLite through SqlitePersistenceProvider',
      ],
    }
  } finally {
    if (provider) provider.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

/** Local artifact path: filesystem object store put -> get on a temp root. */
async function probeLocalObjects(iterations) {
  const directory = await mkdtemp(join(tmpdir(), 'm17-objects-'))
  const samples = { putMs: [], getMs: [], roundTripMs: [] }
  const store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 1024 * 1024 })
  try {
    const body = new Uint8Array(1024).fill(7)
    for (let index = 0; index < iterations; index += 1) {
      const key = `m17/baseline/object-${index}.bin`
      const started = performance.now()
      const putStarted = performance.now()
      await store.put({ key, body, contentType: 'application/octet-stream' })
      samples.putMs.push(performance.now() - putStarted)
      const getStarted = performance.now()
      const stored = await store.get(key)
      samples.getMs.push(performance.now() - getStarted)
      if (stored.body.byteLength !== body.byteLength) {
        throw new Error('M17_OBJECT_BODY_MISMATCH')
      }
      samples.roundTripMs.push(performance.now() - started)
    }
    return {
      id: 'local-filesystem-object-put-get',
      layer: 'artifacts',
      status: 'measured',
      workload: 'FilesystemObjectStore put -> get of a 1 KiB object on a disposable temp root',
      iterations,
      latencyMs: {
        put: summarize(samples.putMs),
        get: summarize(samples.getMs),
        roundTrip: summarize(samples.roundTripMs),
      },
      notes: [
        'single-process developer host',
        'disposable temp root; no repository or profile writes',
      ],
    }
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}

/** Billing path: durable usage ledger reserve loop on disposable SQLite. */
async function probeLocalLedger(iterations) {
  const directory = await mkdtemp(join(tmpdir(), 'm17-ledger-'))
  const samples = { openBudgetMs: [], reserveMs: [] }
  let provider
  try {
    provider = new SqlitePersistenceProvider({ path: join(directory, 'ledger.sqlite') })
    await provider.migrate()
    const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
    await seedUsageLedgerOwner(provider, { workspaceId, executionId, attemptId })
    const store = new SqliteDurableUsageStore(provider)
    const source = { sourceId: 'm17-baseline', idempotencyKey: 'm17-baseline-open' }
    const ledger = new DurableUsageLedger({ store })
    const openStarted = performance.now()
    await ledger.openBudget({
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits: 1_000_000_000,
      maximumTokens: 10_000_000,
      source,
    })
    samples.openBudgetMs.push(performance.now() - openStarted)
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now()
      await ledger.reserve({
        workspaceId,
        executionId,
        reservationKey: `m17-reserve-${index}`,
        maximumMicrounits: 1,
        maximumTokens: 1,
        source: { sourceId: 'm17-baseline', idempotencyKey: `m17-reserve-${index}` },
      })
      samples.reserveMs.push(performance.now() - started)
    }
    const summary = await ledger.summary(workspaceId, executionId)
    if (!summary) throw new Error('M17_LEDGER_SUMMARY_MISSING')
    return {
      id: 'local-durable-usage-ledger-reserve',
      layer: 'billing',
      status: 'measured',
      workload:
        'DurableUsageLedger openBudget + reserve loop on disposable SQLite (SqliteDurableUsageStore)',
      iterations,
      latencyMs: {
        openBudget: summarize(samples.openBudgetMs),
        reserve: summarize(samples.reserveMs),
      },
      notes: [
        'single-process developer host',
        'disposable temp database; no workspace billing state is read or written',
        'execution owner record seeded in the disposable database (test-fixture shape)',
      ],
    }
  } finally {
    if (provider) provider.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

/** Seeds the execution owner record the durable ledger requires, on a disposable store. */
async function seedUsageLedgerOwner(provider, { workspaceId, executionId, attemptId }) {
  const at = '2026-10-08T12:00:00.000Z'
  const owner = ExecutionSchema.parse({
    executionId,
    state: 'completed',
    version: 2,
    correlation: {
      workspaceId,
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
      agentId: 'agt_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
    },
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    attemptCount: 1,
    latestAttemptId: attemptId,
    acceptedAt: at,
    terminalAt: at,
    createdAt: at,
    updatedAt: at,
  })
  const attempt = ExecutionAttemptSchema.parse({
    attemptId,
    executionId,
    state: 'completed',
    sequence: 1,
    version: 2,
    acceptedAt: at,
    terminalAt: at,
    createdAt: at,
    updatedAt: at,
  })
  const recordKey = (value) => `r-${createHash('sha256').update(value).digest('hex')}`
  await provider.transaction(async (transaction) => {
    await transaction.put({
      namespace: 'executions',
      id: recordKey(executionId),
      value: owner,
    })
    await transaction.put({
      namespace: 'execution-attempts',
      id: recordKey(attemptId),
      value: attempt,
    })
  })
}

/**
 * In-process policy authorization. The Cedar evaluator is the repository's
 * FakeCedarEvaluator: this measures the PDP request/document path, not a real
 * Cedar engine, and the note records that.
 */
async function probePolicyAuthorize(iterations) {
  const samples = { authorizeMs: [] }
  const store = new InMemoryPolicyStore()
  const cedar = [
    'permit(',
    '  principal == "User::m17-baseline" &&',
    '  action == Action::"runtime:execute" &&',
    '  resource is Runtime',
    ');',
  ].join('\n')
  const digest = `sha256:${createHash('sha256').update(cedar).digest('hex')}`
  const policyId = 'm17.baseline'
  await store.publish({
    policyId,
    version: 1,
    digest,
    cedar,
    createdAt: new Date(Date.parse('2026-10-08T12:00:00.000Z')).toISOString(),
  })
  await store.activate(policyId, 1)
  const evaluator = new FakeCedarEvaluator([{ effect: 'permit' }])
  const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
  const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
  const request = {
    requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    principal: { type: 'user', id: 'User::m17-baseline', workspaceId, attributes: {} },
    action: 'runtime:execute',
    resource: { type: 'runtime', id: 'Runtime::m17-baseline', workspaceId, attributes: {} },
    context: {
      workspaceId,
      requestedAt: new Date(Date.parse('2026-10-08T12:00:00.000Z')).toISOString(),
      attributes: {},
    },
    policySnapshot: { policyId, version: 1, digest },
  }
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    const decision = await decisionPoint.authorize(request)
    samples.authorizeMs.push(performance.now() - started)
    if (decision.effect !== 'allow') throw new Error(`M17_POLICY_DENIED: ${decision.reasonCode}`)
  }
  return {
    id: 'in-process-policy-authorize',
    layer: 'policy',
    status: 'measured',
    workload: 'CedarPolicyDecisionPoint.authorize with published document and FakeCedarEvaluator',
    iterations,
    latencyMs: { authorize: summarize(samples.authorizeMs) },
    notes: [
      'in-process fake Cedar evaluator; not a real Cedar engine measurement',
      'single-process developer host',
    ],
  }
}

/** Cold import time + RSS delta for one layer entry, in a fresh bun child. */
export function probeLayerImport(entry) {
  const specifier = pathToFileURL(resolve(root, entry)).href
  const childScript = `
const rssBefore = process.memoryUsage().rss
const started = performance.now()
try {
  await import(${JSON.stringify(specifier)})
  process.stdout.write(
    JSON.stringify({
      status: 'measured',
      importMs: Math.round((performance.now() - started) * 1000) / 1000,
      rssBeforeBytes: rssBefore,
      rssAfterBytes: process.memoryUsage().rss,
    })
  )
} catch {
  process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'IMPORT_FAILED' }))
}
`
  const result = spawnSync(process.execPath, ['--eval', childScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_ENV: 'production' },
  })
  const classification = classifyImportProbeChild(result)
  if (classification.status === 'unavailable') return classification
  return {
    ...classification,
    rssDeltaBytes: classification.rssAfterBytes - classification.rssBeforeBytes,
  }
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/**
 * Runs the full #941 candidate baseline and returns the report object.
 * Probe state lives only in temp directories that are removed before this
 * resolves; the caller decides where the report itself is written.
 */
export async function runM17RuntimeBaseline(options = {}) {
  const queueIterations = options.queueIterations ?? readBound('queue')
  const objectIterations = options.objectIterations ?? readBound('object')
  const ledgerIterations = options.ledgerIterations ?? readBound('ledger')
  const policyIterations = options.policyIterations ?? readBound('policy')
  const importProbes = options.importProbes ?? process.env.M17_IMPORT_PROBES !== '0'

  const assignments = []
  for (const layer of M17_LAYERS) {
    assignments.push({ id: layer.id, files: await resolveLayerFiles(layer, root) })
  }
  assertDisjointLayers(assignments)

  const startedAt = new Date().toISOString()
  const layers = []
  for (const layer of M17_LAYERS) {
    const assignment = assignments.find((candidate) => candidate.id === layer.id)
    const complexity = await measureComplexity(assignment.files, root)
    layers.push({
      id: layer.id,
      title: layer.title,
      sourceRoots: layer.include,
      excluded: layer.exclude,
      fileCount: assignment.files.length,
      complexity,
      importProbe: importProbes
        ? probeLayerImport(layer.importProbe)
        : { status: 'skipped', reason: 'M17_IMPORT_PROBES=0' },
    })
  }
  const coupling = await measureCoupling(assignments, root)

  const probes = []
  const probeRunners = [
    ['local-embedded-sqlite-queue-round-trip', () => probeLocalQueue(queueIterations)],
    ['local-filesystem-object-put-get', () => probeLocalObjects(objectIterations)],
    ['local-durable-usage-ledger-reserve', () => probeLocalLedger(ledgerIterations)],
    ['in-process-policy-authorize', () => probePolicyAuthorize(policyIterations)],
  ]
  for (const [id, run] of probeRunners) {
    try {
      probes.push(await run())
    } catch (error) {
      probes.push({
        id,
        status: 'unavailable',
        reason: safeFailureReason(error),
      })
    }
  }

  const rssAfterProbes = process.memoryUsage().rss
  return {
    schemaVersion: 1,
    tool: 'scripts/m17-runtime-baseline.mjs',
    issue: 941,
    status: 'candidate-baseline-unaccepted',
    baselineStatement:
      'This run is a candidate measurement of this repository state only; it asserts nothing about baselines elsewhere in the repository or history and is not an accepted or published #941 baseline.',
    candidate: {
      commit: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: (git('status', '--porcelain') ?? '').length > 0,
    },
    environment: {
      runtime: process.version,
      bun: process.versions.bun ?? null,
      sqlite: process.versions.sqlite ?? null,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
    },
    configuration: {
      queueIterations,
      objectIterations,
      ledgerIterations,
      policyIterations,
      importProbes,
      writePolicy:
        'probe state: disposable os.tmpdir() directories only; report: stdout or the explicit --out path',
    },
    startedAt,
    completedAt: new Date().toISOString(),
    layers,
    couplingMethod: COUPLING_METHOD,
    coupling,
    probes,
    unavailableCosts: M17_UNAVAILABLE_COSTS,
    rssAfterProbesBytes: rssAfterProbes,
    limitations: [
      'single-process developer host; timings are not capacity numbers',
      'no cloud, Restate server, PostgreSQL, provider, or device was contacted',
      'RSS deltas from cold imports are not peak memory',
      'cost figures are labeled unavailable rather than estimated',
    ],
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const outPath = outIndex === -1 ? undefined : argv[outIndex + 1]
  if (outIndex !== -1 && outPath === undefined) {
    throw new Error('M17_OUT_PATH_MISSING')
  }
  const report = await runM17RuntimeBaseline()
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (outPath === undefined) {
    process.stdout.write(serialized)
  } else {
    await writeFile(resolve(root, outPath), serialized, 'utf8')
    process.stdout.write(
      `${JSON.stringify(
        {
          status: report.status,
          layers: report.layers.length,
          probes: report.probes.map((probe) => ({ id: probe.id, status: probe.status })),
          out: outPath,
        },
        null,
        2
      )}\n`
    )
  }
}

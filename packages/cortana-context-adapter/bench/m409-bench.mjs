// M14 #409 validation benchmark — NOT part of the package suite.
// Interleaved A,B,A,B x5 blocks of 500 iterations each; per-iteration wall time
// of the full orchestration (stubbed fetch with realistic 20-80 ms waits,
// streamed 8-chunk body, plus a 0.5 ms CPU leg identical for both sides).
// The stubbed I/O delay sequence is seeded and reset per block, so iteration k
// waits the same for implementation A and B within a block pair.
import { CortanaHttpClient } from '../src/http-client.ts'
import { EffectCortanaHttpClient } from '../src/http-client-effect.ts'

const ITERS = Number(process.env.BENCH_ITERS ?? 500)
const BLOCKS = Number(process.env.BENCH_BLOCKS ?? 5)
const WARMUP_ITERS = Number(process.env.BENCH_WARMUP ?? 100)
const CHUNKS = 8
const CHUNK_BYTES = 256

// Deterministic PRNG so both implementations see identical delay sequences.
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

const payload = JSON.stringify({
  evidence: Array.from({ length: 30 }, (_, i) => ({
    sliceId: `slice-${i}`,
    content: 'e'.repeat(60),
    tokenCount: 15,
    contentDigest: `sha256:${'b'.repeat(64)}`,
    sourceRef: 'corpus://doc/1',
  })),
})
const encoder = new TextEncoder()
const payloadBytes = encoder.encode(payload)
const chunkSize = Math.ceil(payloadBytes.length / CHUNKS)
const payloadChunks = []
for (let i = 0; i < payloadBytes.length; i += chunkSize)
  payloadChunks.push(payloadBytes.subarray(i, i + chunkSize))

function makeDelayingStub(delays) {
  let call = 0
  const stub = (url, init) => {
    const signal = init?.signal
    const delay = delays[call % delays.length]
    call++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(
            new ReadableStream(
              {
                pull(controller) {
                  const chunk = payloadChunks[readerState.next]
                  if (chunk === undefined) {
                    controller.close()
                    return
                  }
                  readerState.next++
                  setTimeout(() => controller.enqueue(chunk), 1)
                },
                cancel() {},
              },
              { highWaterMark: 0 }
            ),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      }, delay)
      const readerState = { next: 0 }
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
  }
  return stub
}

function makeRequest() {
  return {
    objective: 'Read evidence',
    operationId: 'context-http:bench-operation-0001',
    transport: 'http',
    mappedProjectRef: 'project:test',
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    principalRef: 'service:test',
    maximumTokens: 100,
    deadline: new Date(Date.now() + 10000).toISOString(),
    includeEvidence: true,
    includeMemory: false,
  }
}

// 0.5 ms CPU leg — identical arithmetic spin for both implementations.
function cpuLeg() {
  let acc = 0
  const end = performance.now() + 0.5
  while (performance.now() < end) acc = (acc * 31 + 7) | 0
  return acc
}

async function runBlock(Client, delays) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeDelayingStub(delays)
  const client = new Client({
    endpoint: 'http://127.0.0.1:9/read',
    allowLoopbackHttp: true,
  })
  const samples = []
  try {
    for (let i = 0; i < ITERS; i++) {
      const start = performance.now()
      await client.read(makeRequest(), new AbortController().signal)
      cpuLeg()
      samples.push(performance.now() - start)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  return samples
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { p50: pick(0.5), p95: pick(0.95), mean }
}

const clients = [
  ['A-current-promise', CortanaHttpClient],
  ['B-effect-facade', EffectCortanaHttpClient],
]

// Warmup: exercise both implementations so JIT/fiber caches are warm.
{
  const warm = Array.from({ length: WARMUP_ITERS }, () => 20 + Math.random() * 60)
  for (const [, Client] of clients) await runBlock(Client, warm)
}

const perBlock = { A: [], B: [] }
for (let block = 0; block < BLOCKS; block++) {
  // Same seeded delay sequence for A and B within a block pair.
  const delays = []
  const rand = lcg(409 + block * 7919)
  for (let i = 0; i < ITERS; i++) delays.push(20 + rand() * 60)
  const a = await runBlock(clients[0][1], delays)
  const b = await runBlock(clients[1][1], delays)
  perBlock.A.push(stats(a))
  perBlock.B.push(stats(b))
  console.log(
    `block ${block + 1}: A p50=${perBlock.A.at(-1).p50.toFixed(2)} p95=${perBlock.A.at(-1).p95.toFixed(2)} mean=${perBlock.A.at(-1).mean.toFixed(2)} | B p50=${perBlock.B.at(-1).p50.toFixed(2)} p95=${perBlock.B.at(-1).p95.toFixed(2)} mean=${perBlock.B.at(-1).mean.toFixed(2)}`
  )
}

function acrossBlocks(blocks, key) {
  const values = blocks.map((b) => b[key]).sort((x, y) => x - y)
  return { min: values[0], median: values[Math.floor(values.length / 2)] }
}

console.log('\n=== summary (ms; min and median across 5 interleaved blocks) ===')
const rows = {}
for (const key of ['p50', 'p95', 'mean']) {
  const a = acrossBlocks(perBlock.A, key)
  const b = acrossBlocks(perBlock.B, key)
  rows[key] = { a, b, overheadPctMin: ((b.min / a.min - 1) * 100).toFixed(1), overheadPctMedian: ((b.median / a.median - 1) * 100).toFixed(1) }
  console.log(
    `${key}: A min=${a.min.toFixed(2)} med=${a.median.toFixed(2)} | B min=${b.min.toFixed(2)} med=${b.median.toFixed(2)} | overhead min=${rows[key].overheadPctMin}% med=${rows[key].overheadPctMedian}%`
  )
}
const gateP95 = Number(rows.p95.overheadPctMedian)
console.log(`\nGATE (<=10% p95 overhead, median-of-blocks): ${gateP95 <= 10 ? 'PASS' : 'FAIL'} (${gateP95}%)`)

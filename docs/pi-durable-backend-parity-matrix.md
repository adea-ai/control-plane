# Pi Durable backend parity matrix (offline characterization)

Status: evidence only. This records what four storage backends do today when asked for the operations the C2, C4, C7 and
c4b candidates are built on. It changes no backend, adds no SDK patch, and decides nothing.

**Not established here:**

- No claim about a deployed Cloudflare Worker or Durable Object. The "Durable Object" column is a **test double**.
- No assignment of backends to product modes (Local, Self-hosted, Hosted). That mapping is unresolved (see below).
- No SDK adoption, issuer, capture method, activation, or live-store use. The candidate patches stay uncompiled and are
  applied only to temporary copies of the installed SDK.

The test is `packages/pi-durable-adapter/src/candidate-backend-parity.test.mjs` (17 tests). It copies the installed
`@earendil-works/pi-durable@1.1.0` twice into a scratch directory next to the install: once with the compatibility patch
only, and once with the compatibility patch plus the C2, C4, C7 and c4b candidates in that order. It runs on disposable
SQLite files, temporary JSONL directories and in-memory objects, and removes only the directories it created.

## The matrix

"Candidate stack" means the compatibility patch plus C2, C4, C7 and c4b. Cells name what the test observed.

| Operation                               | Node SQLite, compat patch only     | Node SQLite, candidate stack                                             | MemoryStorage                                                | JsonlStorage                                                              | Durable Object SQLite **test double** (candidate stack)    |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Writer fence `acquireWriterFence` (C2)  | method absent                      | works; epoch 1                                                           | method absent                                                | method absent                                                             | works; epoch 1                                             |
| Closure receipt `closeWriterFence` (C4) | method absent                      | works; receipt `pi-writer-closure-receipt/v1`, epoch 2                   | method absent                                                | method absent                                                             | works; same receipt shape                                  |
| Commit after a closure                  | no closure to take                 | `PI_STORE_FENCED`                                                        | accepted (nothing fences a writer)                           | accepted (nothing fences a writer)                                        | `PI_STORE_FENCED`                                          |
| `commitGuarded`                         | method present; not exercised here | works                                                                    | method absent                                                | method absent                                                             | method present; `PI_GUARDED_COMMIT_UNAVAILABLE`            |
| Guarded abort receipt (`commitAbort`)   | not exercised here                 | commits                                                                  | `PI_GUARDED_COMMIT_UNAVAILABLE`                              | `PI_GUARDED_COMMIT_UNAVAILABLE`                                           | `PI_GUARDED_COMMIT_UNAVAILABLE`                            |
| `Session.closeWriters` (c4b)            | not applied                        | returns the receipt; Harness is then closed                              | `PI_SESSION_CLOSE_WRITERS_UNAVAILABLE`; Harness stays usable | `PI_SESSION_CLOSE_WRITERS_UNAVAILABLE`; Harness stays usable              | returns the receipt (needs only the fence and the closure) |
| Read-only open (C7)                     | `openReadOnly` absent              | reads a closed store; writes and fence acquire give `PI_STORE_READ_ONLY` | no such API                                                  | no such API; an unsupported `mode: 'read-only'` option is ignored (see 1) | no exported read-only facade (see 2)                       |
| Survives close and reopen               | not exercised here                 | yes                                                                      | no: a new instance is empty                                  | yes                                                                       | not characterized (the double is in memory)                |

Two cells need more than a table row:

1. **JsonlStorage ignores an unknown `mode` option.** `JsonlStorageOptions` has only `fsync`. Passing
   `{ mode: 'read-only' }` from JavaScript is not an error: the store opens writable and a commit succeeds. The test shows
   this with a disposable directory. It does not say any caller does this; no non-test `.ts`, `.tsx` or `.mjs` source in this
   repository opens a JSONL store.
2. **Durable Object read-only.** The SDK's Durable Object entry exports only `DurableObjectSqliteDatabase` and
   `openDurableObjectSqliteStorage`. `SqliteStorage.openReadOnly(facade)` (C7) accepts any database facade, including a
   facade over the double, and refuses writes with `PI_STORE_READ_ONLY`. The sidecar and live-owner checks C7 performs belong
   to the Node opener, so nothing equivalent runs over a Durable Object facade. In the test a second handle opens while the
   first writer is still open and committing. That is a statement about the SDK code, not about Cloudflare.

## What the Durable Object column is

It is the SDK's own `openDurableObjectSqliteStorage` running over a stand-in for `ctx.storage` built on `node:sqlite` in
memory. The stand-in provides only `sql.exec` and `transaction`, serially, and returns BLOBs as `ArrayBuffer` and integers as
numbers as the binding does. It models none of the platform's input and output gates, hibernation or eviction, transaction
failure behavior, or storage limits. Treat each cell as "the SDK adapter code does this against a minimal single-threaded
SQLite-backed object", never as "Cloudflare does this".

One reading follows from the code, not from the platform: the fence and the closure need only `transaction`, so they work
over the double, while a guarded commit needs a guarded transaction the Durable Object adapter does not define. In the
double, a Session can therefore be sealed and closed (`closeWriters` returns a receipt), but the guarded abort receipts that
closure exists to settle cannot be committed.

## Facts already in the repository

These are stated elsewhere and not changed here:

- The adapter's engine opens Node SQLite storage (`packages/pi-durable-adapter/src/pi-engine.ts`, `openNodeSqliteStorage`).
- `docs/pi-durable-runtime.md` lists "Cloudflare Worker/DO profile" as "Not implemented or qualified" and calls the Cloudflare
  Agents commit a design reference.
- `packages/pi-cloudflare-host/README.md` says that package opens the SDK's Durable Object SQLite driver and has "no
  production Worker route, runtime registration, deployment profile, or advertised capability".
- `native-guarded-abort-compat.test.mjs` already shows MemoryStorage refusing a guarded abort before preparation. This matrix
  adds JsonlStorage and the double beside it.

## Unresolved, and not decided here

- **Product-mode mapping.** Which backend Local, Self-hosted and Hosted use is not stated in any document this slice read, so
  it is left open. The matrix lists capabilities per backend and nothing per mode.
- **Whether a Durable Object backend is in scope for any mode.** If it is, the first gap is a guarded transaction for the
  Durable Object adapter (a separate, later candidate that this slice does not start), and the real platform's transaction
  semantics would need evidence this double cannot give.
- **Whether Memory and JSONL are ever expected to carry a fence.** Today they refuse the guarded paths; they do not fail
  open on `Session.closeWriters`, but a caller that skips it and writes anyway is never fenced.
- **Read-only requests to a backend without the mode.** JSONL accepts the option and ignores it. If a caller can pass a mode
  through, it needs its own refusal.

## Reproduce

From `packages/pi-durable-adapter`, with the repository's pinned Bun (1.4.4):

```
bun test src/candidate-backend-parity.test.mjs
```

While writing it, the test was run with c4b left out of the stack (4 tests failed) and with C7 and c4b left out (7 tests
failed), to confirm it can fail. Those mutated copies are not part of this change.

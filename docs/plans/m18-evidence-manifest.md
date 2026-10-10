# M18 evidence manifest (#1225)

`m18-evidence-manifest.json` maps the 24 requirement ids and A01–A40 named by
[#1225](https://github.com/adea-ai/adea/issues/1225) to evidence. The validator is
`scripts/evidence-manifest.mjs`; run it with `bun run evidence:manifest`.

- `--strict`: exit non-zero unless every id is candidate-compatible.
- `--json`: print the full report.
- `--repo <key>=<path>`: map a repository key to a local checkout. The home key `adea`
  defaults to the worktree root.

The default run prints the revision it checked, the counts, every invalid id, the
pending ids, and an explicit `certification:` line. Exit 0 means the manifest is
internally valid; it does not mean the criteria are certified.

## Current state

The committed manifest pins `adea` to `e8b75daa…`, canonical `main` at the last reconciliation. That head
includes #1246 (artifact-reference grants) and #1251 (directory empty-state coverage, which closes the
#1250 issue). Every execution receipt was regenerated at that head with `bun test <file> --reporter=junit
--reporter-outfile=junit.xml`, plus `--conditions=browser` for files that need it, and each envelope records the
exact command. Every mapped id is `partial`: the cited tests cover part of the criterion, and the gaps are
listed on the entry. Nothing is certified: `certification: incomplete (0 of 64 candidate-compatible)`.

The two DB-backed receipts for A09 (`packages/db/tests/integration/artifact-reference-service.test.ts` and `apps/web/test/integration/artifact-reference-routes.test.ts`) ran against a disposable local database. It came from `compose.yml` and `infra/postgres/init` under its own compose project, and it was torn down afterwards. `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `DATABASE_MIGRATION_URL` pointed at its application and migration roles. `database-health` and `db:verify` passed first. The commands in the receipts record the bun flags and the file, not that environment. The shared local database is not used for receipts.

## Repositories and identity

`repositories` maps a key to `{ name, rootCommit, sourceSha }`:

- `rootCommit` is the immutable identity. A local checkout is accepted only if
  `sourceSha` is a commit in it and `rootCommit` is one of that commit's root commits.
- `sourceSha` is the single revision every reference to that repository must resolve at.

## Entries

`entries[]` is `{ id, coverage, gaps?, criteria?, repoEvidence[], candidateEvidence[], sourceReferences? }`.

- `coverage` is required. `partial` must list `gaps` and cannot carry candidates; its
  status is always `pending`. `complete` must list `criteria` and no `gaps`.
- `criteria` is `[{ text, tests: [{ repository, path, name }] }]`. A criterion is evidenced only if
  every listed test is a runner-verified `test-reference` with the same repository, path, and title.
  Repository identity is part of every match: the same path and title in another repository never
  matches.
- `sourceReferences` (`[{ repository, path }]`) are merged source files that must exist at
  `sourceSha`. They are context, not evidence.

### References

- `{ kind: "test-reference", repository, path, name }`: the title appears in a `*.test.*`
  file at `sourceSha`. This is a source-text match, so comments and strings also match. It
  becomes runner-verified only through an execution-reference whose envelope lists it as
  passing.
- `{ kind: "execution-reference", repository, path, sha256 }`: one JSON envelope
  `{ schema: "adea.evidence.execution.v1", repository, sourceSha, executedAtHead, file, command,
exitCode, status, ids[], summary, junit }`. The envelope binds the repository, the revision,
  and the file inside the hashed bytes, so a receipt copied from another repository or revision
  fails the binding check. `repository` must equal the reference's repository. `sourceSha` and
  `executedAtHead` must equal the pinned SHA. `status` must be `passed` and `exitCode` 0. `junit`
  is the runner's JUnit document, and its per-testcase counts must equal `summary`. A title
  counts only if it passes in every execution-reference for that repository and file.
- `{ kind: "candidate-reference", path, sha256 }`: one JSON envelope
  `{ schema: "adea.evidence.candidate.v1", candidateId, channel, contractVersion, repository,
file, sources, ids[], exitCode, status, summary, junit }`. `sources` must equal the pinned SHA
  for every repository the id references, including the repositories of its `sourceReferences`.
  `repository` must be one of those repositories, and the envelope's JUnit must show every
  testcase passing. A candidate covers only the criterion tests it ran: same repository, same
  file, same title. Any criterion test it does not cover stays explicitly missing, and the id
  stays `repo-verified`.

Paths are repo-relative POSIX paths with no `..`, absolute prefix, or empty segment.

## Statuses

| Status                 | Meaning                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pending`              | No mapping, a partial entry, or an entry without repository evidence. Gaps are listed.                                           |
| `invalid`              | A reference is missing, unmapped, mismatched, unsafe, non-regular, oversized, or not passing, or a complete claim lacks support. |
| `repo-verified`        | A complete entry whose declared tests all passed at the pinned revision and whose criteria are evidenced.                        |
| `candidate-compatible` | A complete entry whose criterion tests are all covered by compatible, all-passing candidate envelopes.                           |

## File safety

- Git blobs must be regular (`100644`/`100755`). Symlinks, submodules, and trees are refused,
  and blobs over 1 MiB are refused.
- Working-tree records must resolve, after symlinks, inside the home root. Outside symlinks,
  directories, and files over 1 MiB are refused before they are read.

## Limits

- An execution envelope is a claim plus runner output in one hashed artifact. Both are committed
  by us, so it is not independent verification. Re-running the command at `executedAtHead` is the
  check.
- Envelopes embed bun's JUnit output with only the machine `hostname` attribute removed. The
  check scans committed artifacts for local paths.
- A `test-reference` proves the title is declared in source text and, with a receipt, that it
  passed. It does not prove the title covers the criterion; that judgement is in `criteria`
  and is human-authored.
- Local checkouts are trusted to be honest copies of the named repository. The root-commit
  check catches the wrong repository, not forged history.
- A shallow checkout (for example, CI's default depth) lacks the pinned root locally. Validation then
  reads the pinned commit from the declared repository through the git remote credentials the checkout
  already has, with no new credentials. The read fetches the commit graph only (`tree:0`), deepening in
  bounded steps (256, 1024, 4096, 16384 commits) until the declared root is found as a parentless
  ancestor, the history is complete, or the last step is reached. It never unshallows. Trees and blobs
  load lazily, and only at the pinned commit. A different repository, an unknown revision, a root that
  is not found within the bound, or a root with parents fails closed. `--local-only` turns the read off.
- Every git read has a deadline and an output limit. A timed-out or failed read is reported as a
  `git read failed` schema error and fails validation closed. It is never a pass, a skip or a missing file.
- The #1225 PRD and TDD (Google Docs) define the requirement and A-id text. They are not in this
  repository, so the manifest carries ids and gaps only.

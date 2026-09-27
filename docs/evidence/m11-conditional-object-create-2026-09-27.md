# M11 conditional object creation checkpoint

Base: `529c5d384991de4e73f3fcbaa5c65c7ac00b3938`; parent PR #743 remains draft.
The independently reviewed Hosted first-write race is still open: separate
artifact stores can both observe a missing key and perform unconditional PUTs.

This checkpoint adds an optional provider-neutral `putIfAbsent` contract and
implements it for R2/S3 with a conditional PUT. It distinguishes an existing
object (412) from an ambiguous conflict (409), refuses unconditional fallback,
preserves validation/error redaction, and keeps normal mutable PUT unchanged.
An existing result deliberately contains no unverified winning descriptor.

Validation:

- Original regression: 1 pass, 8 fail because the capability was absent.
- Final conditional suite: 11 pass, 0 fail, 29 assertions. Includes the actual
  installed AWS SDK's signed HTTP header, two independent adapters over an
  injected atomic provider, provider rejection/conflict/lost ACK, and bounds.
- Object-store, deployment, and Runtime Worker suites, randomized seed 1104:
  116 pass, 0 fail, 355 assertions, 14 files. No filtered or skipped tests.
- Workspace build: 41 successful, 41 total, 0 cached.
- Strict changed-file lint, formatting, and whitespace checks passed. One
  initial lint warning for mutable array sorting was fixed with `toSorted`.
- Architecture: 41 packages, 16 operations, 4 profiles.
- Live requirements: 200 requirements, 103 issue audits.
- Boundaries: 1495 files, 41 packages, no issues.

Remaining acceptance and integration:

1. Implement crash-safe atomic conditional creation in filesystem storage.
   Publishing body and metadata in separate steps is not sufficient; test
   independent instances/processes, symlinks, torn publication and cold restart.
2. Require the capability at the Hosted artifact writer's first-write boundary,
   read and verify winners, reject mismatched results, and preserve lost-ACK
   recovery without unconditional fallback. Test unsupported stores fail closed.
3. Quiesce legacy/unconditional writers for the immutable artifact namespace;
   conditional writes do not fence deletion or unrelated authorized overwrites.
4. Run scoped live provider/profile acceptance and verify production authority
   wiring. Injected SDK tests are not deployment or credential acceptance.
5. Retain every original M11 issue and independent/manual acceptance gate.

Resources: no delegated workers, servers, PostgreSQL starts, paid staging
activation, or cloud storage mutation. Both test/build command handles settled;
existing M11 checkouts and stopped PostgreSQL volume remain owned by the
unfinished goal. No unrelated processes were stopped.

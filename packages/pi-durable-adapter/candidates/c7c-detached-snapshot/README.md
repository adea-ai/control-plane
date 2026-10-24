# CANDIDATE — C7c detached snapshot, method A, for Pi Durable 1.1.0 (not consumable)

**Status: candidate only. Offline planning and tests. Not consumable until root explicitly approves it.**
It is not listed in `patchedDependencies`, no install step applies it, nothing imports it and no export changes. The
compatibility patch (`patches/@earendil-works%2Fpi-durable@1.1.0.patch`) and the C2, C4 and C7 candidates are untouched.
No SDK adoption, issuer, live capture, migration, credential or resource is involved. Tests apply it only to temporary copies
of the installed SDK and run on disposable SQLite files.

`c7c-detached-snapshot.candidate.patch` applies **on top of** the compatibility patch and the C2, C4 and C7 candidates. It adds:

- `dist/storage/sqlite/snapshot.js` (and `.d.ts`): `sealSnapshot(artifactPath, pins)`, `snapshotFacts(handle)` and
  `withSnapshotStorage(handle, read)`;
- `dist/storage/sqlite/open-registry.js` (and `.d.ts`): an in-process record of read-write opens by device and inode;
- a hook in `node.js` that registers a read-write open and forgets it when that database closes.

Nothing is exported from the SDK index. The default C7 read-only open is unchanged: a store with `-wal`, `-shm` or `-journal`
sidecars is refused, and no mode reads a database together with its WAL.

The full design, the refusal codes, method B (specified, not implemented) and the limits are in
`docs/pi-durable-c7c-detached-snapshot-design.md`. In short, a sealed snapshot is historical evidence of one committed cut. No
in-process registry entry and no stable bytes prove cross-process quiescence; that is out-of-band attestation. No caller-supplied
boolean is production attestation. A snapshot never settles a journal or authorizes an effect.

Test: `packages/pi-durable-adapter/src/candidate-c7c-detached-snapshot.test.mjs`.

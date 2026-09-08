# M11 operational policy fingerprint correction

Scope: M11.9 (#194), operational configuration traceability. This is not
retention/deletion acceptance or deployment certification.

The exported `operationalPolicyDigest` previously supplied only top-level keys
as the `JSON.stringify` property allowlist. That allowlist also applies inside
nested objects, excluding all retry, heartbeat, freshness, retention, payload,
and shutdown settings. Policies with different settings therefore shared a hash.
Repository search found no production callers; the export and its configuration
test were the only references. No deployed policy enforcement bypass is claimed.

The replacement sorts object properties recursively without excluding values.
Regression tests change each numeric setting independently and reverse property
insertion order at both levels. The setting-sensitivity test failed against the
previous implementation and passes with the fix; reordered equivalent policies
retain the same digest. Existing policy schema and defaults are unchanged.

Digest consumers must recompute fingerprints after upgrading. The previous
fingerprint cannot establish equivalence between operational configurations.
There is no database migration or new cleanup operation in this change.

Validation: focused policy tests pass (4 tests, 26 assertions); workspace lint,
type-check, format check, and `bun run test` pass (983 unit, 104 E2E, 67 smoke).
Task-owned test processes exited and ports 8080, 9070, 19083, and 19085 were clear
after verification. No workers were spawned for this change.

Retention remains incomplete: configured durations do not establish a deletion
worker, terminal eligibility, legal holds, replay tombstones, or backup expiry.
Validation receipts explicitly remain indefinitely retained. These requirements
must be implemented and verified independently before closing M11.9.

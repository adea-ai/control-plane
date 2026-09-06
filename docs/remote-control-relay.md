# Remote control relay

The Local and Hosted Control Plane compositions may attach an optional outbound-only remote-control adapter. The adapter lets an external product submit durable commands without opening an unrestricted Control Plane administration listener and without giving the relay plaintext execution content.

The Control Plane remains independently usable when the adapter is disabled. Runtime Gateway is not part of this path: it transports runtime commands to non-co-located RuntimeNodes, while this adapter transports product-control commands to the selected Control Plane host.

## HPKE envelope v1

Content-bearing commands and responses use RFC 9180 HPKE Base mode with this pinned suite:

- DHKEM(X25519, HKDF-SHA256);
- HKDF-SHA256;
- AES-128-GCM;
- maximum ciphertext size of 1 MiB;
- maximum envelope lifetime of 24 hours.

The canonical associated data binds the envelope and suite versions, recipient key, workspace, host, command, payload type and schema version, issue/expiry timestamps, digest, and optional client return key. Any wrong recipient, unsupported version/suite, malformed field, expiry, revocation, downgrade, or tamper fails closed.

The browser-compatible golden fixture is in `packages/remote-control-relay/fixtures/golden`. Its fixed recipient private key and deterministic sender key material are test data only. The deterministic encryption helper is excluded from the package root and cannot be imported through the published package exports; production encryption always creates a fresh ephemeral sender context.

## Host key storage and lifecycle

The host X25519 key is separate from API authentication and signing credentials. Local packaged deployments resolve it through a `host-secure` handle. Standalone Local and Hosted deployments may resolve an owner-only private file, Docker secret, environment-backed reference, or another `SecretsProvider` implementation. The loader validates the fingerprint, key ID, host binding, and cryptographic public/private pairing before import, then closes and zeroes the secret lease.

The secret value is strict JSON matching `HostEncryptionKeyPair`; it must never be stored in SQLite/PostgreSQL, an Artifact, relay registration, logs, or telemetry. Relay registration receives only the public key, key ID, fingerprint, host ID, and creation timestamp.

Rotation registers a new active public key. The previous private key may decrypt already queued envelopes only through an explicitly bounded grace period no longer than 24 hours. Revocation withdraws the matching relay registration before removing local decryption eligibility; if relay withdrawal fails, the local key remains available so an advertised key cannot become undecryptable. The relay cannot re-encrypt queued content because it never has plaintext.

## Delivery and reconciliation

`RemoteControlHostAdapter` registers and continuously polls over an injected outbound client. It does not bind a socket. Polls are bounded, serialized, and retried after transient failures, so a slow poll cannot create overlapping command effects. Local and Hosted compositions accept an optional factory that receives their normal durable execution-acceptance service, so operators can construct the adapter without opening another API listener or creating a parallel execution ledger.

Content is decrypted and authenticated only after host/workspace/recipient/expiry validation, then passed to the normal command acceptance boundary. `RelayExecutionCommandProcessor` requires the encrypted `create_execution` body to satisfy the public execution-acceptance schema and binds its workspace, command ID, and caller principal to the selected host configuration before invoking that service. CommandInbox therefore remains the durable idempotency boundary: deterministic redelivery returns the existing logical execution and does not resubmit its workflow. A generic durable duplicate result is returned only after the redelivered envelope authenticates and its plaintext digest matches the original command. Concurrent delivery converges only when the complete canonical envelope matches; plaintext buffers are zeroed after acceptance.

The relay-visible status projection is a strict allowlist:

- workspace, host, and command IDs;
- one bounded lifecycle state;
- an optional machine-readable reason code;
- occurrence timestamp and schema version.

Prompt text, history, repository content, ContextPackages, provider memory, private paths, credentials, results, and error messages are never fields in this projection. A transient or unknown acceptance outcome remains unacknowledged for reconciliation; permanently invalid cryptographic envelopes are rejected and acknowledged so they cannot become poison deliveries.

Metadata-only cancel, resume, approval, denial, and status operations use a separate strict, authenticated command schema. They are scoped, reject commands issued beyond the allowed clock skew, expire within the same 24-hour bound, and bind each idempotency key to the exact command body. Their command-result repository must be backed by the selected Local or Hosted durable persistence provider when the adapter is configured; the in-memory repository is a test/default seam, not restart durability. Authentication of that metadata transport remains the responsibility of the concrete relay client; the host processor never treats an unauthenticated object as trusted merely because it matches the schema.

## Verification

The package conformance suite covers deterministic fixture interoperability, all associated-data fields, wrong keys, expiry, size limits, response return keys, malformed/downgrade cases, key loading/rotation/revocation, relay ciphertext opacity, reconnect/redelivery, serialized continuous polling, concurrent duplicate acceptance, an encrypted public execution request crossing the real CommandInbox service exactly once, outbound-only registration, bounded status projections, the full metadata operation matrix, and metadata idempotency. It uses the fake opaque relay and requires no Adea source, deployment, or database.

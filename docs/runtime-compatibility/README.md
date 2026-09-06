# Runtime compatibility certification

`runtime-certifications.v1.json` is the exact, machine-readable certification registry and
`runtime-certifications.schema.json` is its generated language-neutral schema. The broader
`runtime-compatibility.v1.yaml` describes planned and provider-specific paths; it does not grant an
uncertified version combination production eligibility.

## Classification and eligibility

Certification matches the runtime family, connection type, location, adapter, driver, harness, and
protocol versions exactly. The classifications map into RuntimeConnection state as follows:

- `supported` becomes compatible when every certified capability is still negotiated.
- `preview` and `degraded` remain executable only as degraded connections with explicit limitations.
- `untested`, including every unmatched version combination, is degraded and never presented as
  fully supported.
- `incompatible` is unavailable and ineligible.
- `revoked` is unavailable, ineligible, and terminal until a new certification is published.

Capabilities outside a certification are downgraded to unsupported. If a capability asserted by a
certification disappears from negotiation, the connection becomes unavailable with
`CERTIFIED_CAPABILITY_MISSING`. These rules keep Adea discovery read models honest because the
same compatibility state and limitation codes feed health, eligibility, and read-model projection.

## Upgrade and deprecation policy

Adapter, driver, harness, protocol, connection-type, or location changes require a new exact matrix
entry and fresh automated evidence. Version ranges and same-major assumptions do not inherit
certification. Minimum versions are recorded in the matrix as policy documentation; they are not a
substitute for an exact certified combination.

Deprecation starts by adding a limitation and classifying the replacement as `preview` or
`supported`. A combination becomes `incompatible` only after its documented support window, except
for urgent correctness or security failures, which may move directly to `revoked`. Existing matrix
entries remain immutable evidence; replacement evidence is added as a new certification and the
matrix version advances.

The current minimum reference versions are Managed Pi adapter/driver 1.0.0, Pi 0.52.0, and Runtime
Gateway protocol 1.5.0; and ACP adapter/driver 1.0.0, ACP reference harness 2.4.0, and Runtime Gateway
protocol 1.5.0. Current `supported` entries certify only the in-repository disposable reference
drivers and harnesses. Adea production compatibility remains a separate pre-release gate.

Run `bun run compatibility:check` from the repository root whenever an adapter, driver, harness,
protocol, capability claim, or certification file changes. The check validates the matrix, verifies
that every evidence source exists, and rejects generated-schema drift.

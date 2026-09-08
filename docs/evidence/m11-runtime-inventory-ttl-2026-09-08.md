# M11 runtime inventory TTL

## Normalizer boundary follow-up

The ingestion correlation check now also rejects a normalized capability TTL
greater than the driver's advertised lifetime, or sixty seconds when omitted.
This closes a reproduced extension through an injected normalizer even though
the default normalizer already preserved the advertised value. A conservative
shorter lifetime remains permitted. Validation runs before any registry,
projection, availability-event or checkpoint mutation; the regression includes
a valid sibling driver to check that an invalid batch does not partially apply.
Focused tests cover advertised extension, legacy ceiling extension and a valid
shorter normalized lifetime. These are in-memory ingestion tests, not evidence
of deployed scheduling, provider consumers or Local inventory freshness.

Scope: CP-RNODE-011, default remote runtime inventory ingestion. The revalidated
RuntimeNode specification requires inventory freshness of at most 60 seconds,
with shorter safe TTLs advertised by concrete adapters/providers respected.

Two focused regressions reproduced the default runtime-path gap: the protocol
rejected a TTL field, while direct normalization changed an advertised 5,000 ms
into 60,000 ms. Protocol v1.6 now permits optional `capabilityTtlMs` from 1 through
60,000 on inventory driver descriptors. Earlier negotiated versions reject the
field; omitted fields preserve the 60-second default. The generated JSON schema
includes the version condition explicitly because Zod refinements are not
automatically represented by its JSON-schema conversion.

The default runtime normalizer preserves the advertised TTL. A regression runs
the real normalizer through inventory ingestion and health refresh, verifies the
five-second expiry, and observes stale availability at 5,001 ms. Its registry and
checkpoints are in-memory fixtures, not deployed persistence or live node proof.

The wider suite initially exposed stale v1.5-only acceptance/certification
expectations. Historical v1.5 certifications and the minimum supported version
are retained. Separate v1.6 reference-driver certifications cover the actual
negotiated Pi/ACP gateway tests; the matrix is version 1.1.0. These records retain
`REFERENCE_DRIVER_CERTIFICATION` and do not certify native host deployment.
Matrix tests enumerate both protocol versions and select a named legacy record
for its incompatible/revoked scenarios rather than relying on array order.

This does not implement a ContextProvider inventory consumer, configure a live
node to advertise TTLs, change heartbeat timing, or prove all-profile freshness
and scheduling behavior. CP-RNODE-011 and M11 remain open at their full scope.

Validation: root lint, type-check, format-check and full tests pass (995 unit,
105 E2E, 67 smoke; 41 workspace builds). The separate disposable PostgreSQL run
passes 28 database tests, the other configured integration lanes, authenticated
scripted remote delivery and outage/restart/backup-restore drills. These are
local/reference results, not a live native-worker or provider certification.

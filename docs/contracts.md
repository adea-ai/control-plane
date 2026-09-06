# Adea ↔ Control Plane contracts

`@control-plane/contracts` 1.x is the publishable, runtime-independent service boundary between Adea and the
Control Plane. Adea supplies authorized product intent and workspace identity; the Control Plane
applies execution policy and owns runtime semantics. The package depends only on Zod and can build
without Control Plane domain, database, application, workflow, or adapter packages.

## Canonical identifiers

Identifiers are opaque, prefix-qualified ULIDs. Consumers may validate and compare them, but must not
derive database keys, timestamps, routing decisions, filesystem paths, or vendor-native identifiers
from their contents.

| Identifier            | Prefix |
| --------------------- | ------ |
| Request               | `req_` |
| Command               | `cmd_` |
| Workspace             | `wsp_` |
| Project               | `prj_` |
| Task                  | `tsk_` |
| Agent                 | `agt_` |
| AgentProfile          | `prf_` |
| AgentProfileVersion   | `pfv_` |
| Skill                 | `skl_` |
| SkillVersion          | `skv_` |
| Execution             | `exe_` |
| Attempt               | `att_` |
| Workflow              | `wfl_` |
| Interaction           | `int_` |
| RuntimeDefinition     | `rtd_` |
| RuntimeNode reference | `rnr_` |
| RuntimeConnection     | `rtc_` |
| External session      | `ses_` |
| ProjectState item     | `psi_` |
| State mutation        | `stm_` |
| Promotion proposal    | `spp_` |
| ContextPackage        | `ctx_` |
| ExecutionPlan         | `pln_` |
| Artifact reference    | `art_` |
| Event                 | `evt_` |
| Trace                 | `trc_` |

Prefixes prevent accidental identifier substitution; the suffix remains opaque. Runtime-native
workflow/session IDs, database UUIDs, process handles, local paths, and credentials are never public
identifiers.

## Envelopes

All public envelopes carry `{ major, minor }` `contractVersion` metadata and purpose-built public
data rather than persistence rows.

- Read requests carry request, workspace/project, operation, timestamp, trace/correlation data, and
  an additive calling-service assertion used by authenticated routes.
- State-changing commands additionally require a command ID, idempotency key, and canonical payload
  hash. The hash is lowercase SHA-256 over RFC 8785 canonical JSON bytes. Reusing an idempotency key
  with a different hash is a conflict; retrying the same key and hash is safe.
- Responses contain either `data` or a normalized `error` plus request/correlation metadata.
- Events identify the event, workspace/project, occurrence time, causation, and normalized data.
- Usage records expose provider-neutral token, duration, and optional ISO-currency cost totals.
- Artifact references expose an opaque locator, media type, immutable version, size, and SHA-256
  digest—not a database row or provider credential.
- Runtime read models expose Control Plane status and opaque RuntimeNode/connection references. They
  never expose local paths, device credentials, process handles, or native harness configuration.

Browser/user credentials, Adea service credentials, RuntimeNode device credentials, and
provider/harness credentials are distinct trust boundaries. None belongs in these generic payloads.

## Service authentication

Adea calls protected Control Plane routes with a bearer credential verified by a configured
`ServiceCredentialVerifier`. The verifier is a replaceable infrastructure adapter: it must verify the
credential signature against currently trusted Adea keys before returning claims. The policy
authenticator then independently enforces these claims:

| Claim             | Requirement                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `credentialKind`  | Exactly `service`; browser sessions, RuntimeNode devices, and provider keys fail |
| `issuer`          | Exact configured Adea issuer URL                                                 |
| `audience`        | Exact configured Control Plane audience                                          |
| `principalId`     | Stable `svc_`-prefixed service identity                                          |
| `credentialId`    | Unique revocation handle                                                         |
| `keyId`           | Trusted signing-key selector used by the verifier                                |
| `issuedAt`        | Not in the future beyond configured clock skew                                   |
| `expiresAt`       | After issuance and not expired beyond configured clock skew                      |
| scopes            | Explicit operation scopes; wildcard/ambient grants are invalid                   |
| workspace/project | Canonical IDs allowed for this service credential                                |

Protected routes declare their required operation scopes. The authenticator also parses the request
as a current versioned read or command envelope, requires the asserted calling-service ID to match the
verified principal, and requires its workspace and optional project to appear in the verified grants.
The caller assertion remains optional at the generic v1 parsing layer for additive compatibility but
is mandatory at every authenticated route. Authentication establishes caller identity only: domain
and execution policy must still authorize the requested action.

Internal workers use `internal_service` principals created with explicit scopes. They do not inherit
Adea user permissions and are not accepted as external bearer claims. Deployments remain
fail-closed with `SERVICE_AUTH_NOT_CONFIGURED` until an authentication adapter is supplied.

### Credential lifecycle and audit policy

- Adea publishes overlapping old and new verification keys during rotation. New credentials use
  the new `keyId`; the old key is removed only after its final credential expiry plus clock skew.
- Credentials are short-lived. The default clock-skew allowance is 30 seconds and may be narrowed by
  deployment policy. A credential whose issuance is too far in the future or whose expiry is outside
  the allowance fails closed.
- Emergency revocation is keyed by `credentialId` and checked on every authenticated request. Key
  compromise revokes the key in the verifier as well as every still-live credential it signed.
- Service bearer credentials are reusable until expiry or revocation; request replay protection is
  provided by command IDs, idempotency keys, and payload hashes. Reusing an idempotency key with a
  different payload remains a conflict rather than a second command.
- Authentication logs contain stable result codes, request IDs, and the principal ID only after claims
  parse. Raw bearer values, signatures, authorization headers, credential payloads, and verifier
  exceptions are never logged or returned.

Normalized boundary codes include `SERVICE_CREDENTIAL_REQUIRED`,
`SERVICE_CREDENTIAL_MALFORMED`, `SERVICE_CREDENTIAL_CLASS_REJECTED`,
`SERVICE_CREDENTIAL_INVALID_ISSUER`, `SERVICE_CREDENTIAL_INVALID_AUDIENCE`,
`SERVICE_CREDENTIAL_NOT_YET_VALID`, `SERVICE_CREDENTIAL_EXPIRED`,
`SERVICE_CREDENTIAL_REVOKED`, `SERVICE_CREDENTIAL_SCOPE_MISMATCH`, and
`SERVICE_REQUEST_ENVELOPE_INVALID`. Authentication failures return 401, scope failures return 403,
invalid envelopes return 400, and an unconfigured deployment returns 503.

## Error classification

Normalized errors use one of: `validation`, `authentication`, `authorization`, `conflict`,
`stale_reference`, `capability_mismatch`, `runtime_unavailable`, or `internal`. The stable machine
code and retryable flag refine the class. Public messages are bounded and must not contain credentials,
stack traces, queries, or persistence details.

## Compatibility and negotiation

The current boundary is `3.0`.

- A major version change is breaking. Removing or renaming fields, making an optional field required,
  narrowing valid values, or adding a closed-enum value requires a major version.
- A minor version is additive only. New fields must be optional, defaults must preserve prior
  behavior, and producers must continue accepting the earlier same-major form.
- Envelope schemas tolerate unknown additive fields so an older same-major consumer can safely parse a
  newer producer. Consumers use only the recognized result.
- Peers advertise supported versions. Negotiation selects the highest common major and the lower of
  each peer's highest supported minor for that major. No common major fails closed before dispatch.
- Deprecations record their effective time, an optional later sunset, replacement version, and
  documentation. A sunset cannot precede deprecation. Removing a supported major requires the
  announced breaking-version path.

`PublicContractFixtures` supplies deterministic provider and consumer fixtures. Compatibility tests
must parse both the current fixture and same-major additive variants; a breaking change must update
the major boundary explicitly.

# Profile adapters

This package binds an explicitly selected product execution profile to the
existing deployment, workflow, runtime, and placement ports. It is a
server-side composition helper. It does not create credentials, grants, runtime
routes, or residency authority.

## Profile mapping

The product profile names are intentionally distinct from the canonical
`DeploymentProfile` values:

| Product profile | Canonical deployment profile | Source-backed storage and wake path     |
| --------------- | ---------------------------- | --------------------------------------- |
| `local`         | `local`                      | SQLite with the embedded workflow queue |
| `self-hosted`   | `hosted-simple`              | SQLite with Restate                     |
| `self-hosted`   | `hosted-server`              | PostgreSQL with Restate                 |
| `hosted`        | `cloud`                      | PostgreSQL with Restate                 |

The exact display labels map to the lowercase product names as follows:
`Local` to `local`, `Self-hosted` to `self-hosted`, and `Hosted` to `hosted`.
Other capitalization and aliases are rejected. In particular, a self-hosted
deployment must already identify either `hosted-simple` or `hosted-server`; if
that canonical variant is missing or unsupported, binding is unavailable rather
than guessed. `DeploymentComposition` proves only that the already configured
storage and workflow ports match that canonical deployment profile.

The source-level matrix is not a live certification. Runtime support is
conditional for Local and Self-hosted and unavailable for Hosted in this
package. The internal Cloudflare adapter currently reports degraded health,
no capabilities, and no registered deployment profile. The Node Pi adapter's
`CLOUD_PROFILE_UNQUALIFIED` limitation is specific to that adapter. Neither
fact is presented as evidence about every possible hosted topology. There is
no implicit fallback from Hosted to a local or self-hosted runtime.

## Runtime binding and authority

`bindProfileRuntime` takes a server-selected `RuntimeAdapter`, its concrete
`RuntimeTransport`, and server-owned placement as separate inputs. The expected
transport is derived from the profile and trusted placement. A required
`CurrentProfileRuntimeTopologyGuard` must compare the exact adapter and
transport instances with the server's configured topology before inspection
and again at runtime boundaries. The `RuntimeAdapterWithTransport.transportKind`
property and inspection metadata are checked for consistency only; neither is
used as an execution route. Runtime calls continue through the semantic adapter
that the trusted topology approved.

Current actor authority and data residency are separate required server-side
guards. Authority must be bound to the authenticated original actor and
re-read current audience, grants, expiry, and exact plan/scope before effects.
The guard also binds the exact attempt and full retained handle tuple on
runtime operations.
The guard must derive canonical workspace scope from retained server records
and cross-check any workspace identifier present in a request; the adapter
binding does not make request fields authoritative.
Residency must recheck the configured host and data-placement policy. Both
guards run before and after runtime operations; progress is rechecked before
each emitted event and preserves the runtime's sequence and timestamp. The
package's guard contexts contain identifiers and plan pins only. Runtime and
wake instances are passed ephemerally to topology guards and must not be
logged, serialized, or persisted.

Capability declarations are support metadata, not authorization. The package
recomputes eligibility from the inspected capabilities for requested features
and from the immutable plan requirements before `start`. An absent required
capability fails closed. The package does not add capabilities or infer
eligibility from method presence.

`bindProfileWorkflowWake` accepts only the dispatcher for the exact canonical
profile (`embedded-sqlite-queue` for Local, `restate-ingress` otherwise). It
does not create a dispatcher or retry through a different profile. Its
server-owned topology guard verifies the exact dispatcher instance; profile
and wake-kind labels alone are not proof. Current authority and residency are
checked before and after each submit.

## Source basis

The mapping follows the current sources in `packages/deployment`,
`packages/sqlite-persistence`, `apps/local-control-plane`,
`apps/hosted-control-plane`, `apps/workflow-worker`, and
`packages/workflow-runtime`. Runtime behavior follows `packages/runtime-sdk`
and the internal adapters in `packages/pi-cloudflare-host` and
`packages/pi-durable-adapter`. This documents those source boundaries; it does
not claim that the separate profile-specific adapter map requested by issue
#941 has been accepted or that Hosted runtime is qualified.

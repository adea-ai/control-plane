# RuntimeNode identity operations

The Hosted/PostgreSQL Runtime Gateway accepts short-lived RuntimeNode credentials
that are signed by an operator-controlled Ed25519 issuer. Key registration and
credential issuance are deliberately offline operator actions, not product
enrollment endpoints. M12/product enrollment is still a separate integration.

## Before issuing credentials

- Apply the database migrations using the migration role.
- Generate the operator Ed25519 issuer key outside the gateway host and keep its
  private half offline or in the operator's protected key service. Only the
  matching public PEM belongs in
  `RUNTIME_NODE_IDENTITY_ISSUER_PUBLIC_KEYS_JSON` on the gateway.
- Generate a separate Ed25519 proof key for each RuntimeNode. Keep its private
  half on that host; register only its public PEM. Never reuse an issuer key as
  a device key.
- Use the exact node/workspace identifiers, issuer URL, and audience configured
  for that Hosted deployment. Track the next channel generation per node; each
  new connection attempt needs a fresh one-use credential and a generation
  greater than the node's last accepted generation.
- Provide the CLI's migration-role connection through the normal secret
  configuration. The explicit `--host`, `--port`, and `--database` arguments
  must match that connection target; the CLI checks this before connecting.

## CLI

Run from the repository root with Bun. Replace placeholders locally; do not put
passwords or private key contents on the command line.

Register a node proof public key:

```sh
bun scripts/runtime-node-identity-admin-cli.mjs register-key \
  --host <database-host> --port <database-port> --database <database-name> \
  --confirm register-key --key-id <device-key-id> \
  --node-id <runtime-node-id> --workspace-id <workspace-id> \
  --public-key /absolute/path/to/device-public.pem
```

Issue one credential (TTL is limited to 600 seconds):

```sh
bun scripts/runtime-node-identity-admin-cli.mjs issue \
  --host <database-host> --port <database-port> --database <database-name> \
  --confirm issue --key-id <device-key-id> \
  --node-id <runtime-node-id> --workspace-id <workspace-id> \
  --issuer https://identity.example/runtime-nodes \
  --audience control-plane-runtime-gateway \
  --channel-generation <next-generation> --ttl-seconds 300 \
  --issuer-key-id <operator-key-id> \
  --issuer-private-key /absolute/path/to/offline-issuer-private.pem \
  --output /absolute/path/to/protected/runtime-node.credential
```

The issuer private-key file must be a regular file owned by the current operator
and inaccessible to group/other users. Credential output uses exclusive,
atomic creation with mode `0600`; an existing path is never overwritten. The
database stores credential claims and public keys only. Standard output returns
the credential ID, not the compact credential; the compact credential is
written only to the protected output file. Install it in the node's protected
secret store, then delete the transfer copy according to the host's secure
handling policy.

Revoke one credential:

```sh
bun scripts/runtime-node-identity-admin-cli.mjs revoke-credential \
  --host <database-host> --port <database-port> --database <database-name> \
  --confirm revoke-credential --credential-id <credential-id>
```

Hosted operators can also revoke through `POST /v1/runtime-node-credentials/revoke`
(scope `credential:write`, envelope workspace bound). The route runs under the
application role and calls the migration-owned `revoke_runtime_node_credential`
function. Every applied, replayed, and workspace-refused outcome is written to
`runtime_node_credential_audit_events`, an append-only table that the application
role cannot read or write. Unknown credential identifiers return not found without
an audit row.

Privilege contract (migration 0069, SOURCE only; no live grant is made by the
repository):

```sql
REVOKE ALL ON FUNCTION public.revoke_runtime_node_credential(varchar, varchar, varchar, timestamp with time zone) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_credential_audit_events FROM control_plane_app;
GRANT EXECUTE ON FUNCTION public.revoke_runtime_node_credential(varchar, varchar, varchar, timestamp with time zone) TO control_plane_app;
```

The application role keeps the migration 0054 privileges: `SELECT` on both identity
tables and `UPDATE (consumed_at)` on issued credentials. It gets no table write on
`revoked_at` or `revocation_version`, so it cannot change the revocation columns
except through the function. The migration owner runs the function as
`SECURITY DEFINER` with `SET search_path = pg_catalog, public`.

Retire a device verification key (all credentials bound to that key cease to
authenticate):

```sh
bun scripts/runtime-node-identity-admin-cli.mjs retire-key \
  --host <database-host> --port <database-port> --database <database-name> \
  --confirm retire-key --key-id <device-key-id>
```

These mutations are intentionally explicit and are not self-service or
automatically reversible. The CLI emits normalized diagnostic codes only; do
not add database URLs, private-key material, compact credentials, signatures,
or proof headers to logs or support tickets.

## Runtime boundary

The gateway receives issuer public-key trust and uses the restricted
application-role connection. It never receives issuer signing authority. A
credential is consumed atomically on authentication and cannot be replayed at
another gateway instance. Revocation and key retirement are durable database
state; active gateways also receive invalidation notifications. The current
proof covers the operator-issued identity boundary, not live product enrollment,
host packaging, production deployment, or independent profile acceptance.

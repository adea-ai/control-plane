# Railway infrastructure as code

`.railway/railway.ts` is the single Railway project definition for the Cloud profile. It owns
service sources, build/start commands, health checks, restart behavior, private endpoints, the
pinned Restate image, and the Restate volume attachment in the configured topology. A declared
volume attachment does not prove that a live volume exists. Secret values use `preserve()` and
remain in Railway.

The TypeScript definition is the **activation profile** and deliberately declares one replica per
service. Railway's Infrastructure as Code schema rejects zero replicas, so the local-first MVP
standby baseline is owned by `infrastructure/railway/cost-policy.json` and applied with
`bun run railway:standby --environment <environment> --apply --confirm <environment>`. The command
disconnects application sources and removes active deployment revisions, preserving services,
configuration, and any volumes that exist. It also removes queued, building, initializing, or otherwise
reactivatable revisions so delayed provider work cannot restart compute after verification.
`railway config apply` is therefore an activation operation, not a routine standby reconciliation
command.

Production promotion owns the control-api image. The definition requires
`CONTROL_PLANE_PRODUCTION_IMAGE` to be an immutable control-api GHCR digest; it does not contain a
release digest. Use `bun run railway:production-plan` for production previews. The helper discovers
the linked project/environment/service, reads the configured source and active deployment through a
narrow Railway API query, and requires their immutable image and digest to match an active successful
deployment. It injects that freshly read image only for the read-only plan, rejects stale caller input,
wrong targets, any source diff, and changes observed during planning. Link the CLI to
`control-plane` production before running it. It prints a plan only after all guards pass; it never
applies. A missing image, connected Git source, mutable tag, pending promotion, or concurrent change
fails closed.

Staging continues to use the `main` GitHub source without a production image input. Link the Railway
CLI to staging and run `railway config plan` there. Review the complete plan before applying it.
Production and staging must be planned and applied separately; never apply a staging plan to
production. Destructive changes require explicit confirmation.

### Running the plan locally

The IaC engine ships in the CLI and guards against an out-of-date CLI by shelling out to
`process.env._`, falling back to `railway` on `PATH`. `_` is the shell's last-argument variable, so in
an ordinary shell it points at whatever token came last — a directory, not the binary. The guard then
fails with a misleading `This version of railway/iac requires Railway CLI 5.42.1 or newer` even
though the installed CLI is current.

For a direct read-only CLI invocation, point `_` at the binary:

```sh
env _="$(command -v railway)" railway config plan
```

A stale CLI is the only reason to see that message, so check `railway --version` before concluding
anything else is wrong. `railway config plan` is read-only: it reconciles the authoring file against
the linked project and environment without changing either, and `--detailed-exit-code` exits 2 when
changes are pending for CI gating. The production helper sets `_` for its own CLI invocation.

**The engine treats an omitted field as a deletion** (the CLI documents this as "omit=delete"), which
has two consequences this file must respect:

- Every variable that exists in a live environment must be declared here — as a literal, or as
  `preserve()` when the value is a secret or provider-owned. Omitting one deletes it. That is how the
  retired `COMMIT_SHA` service variables reconcile away, and it is why the production
  `MARKETPLACE_REGISTRY_*` variables are declared as preserved: undeclared, a production apply would
  have deleted the marketplace registry URL and token.
- Production image sources are owned by the container-promotion workflow, and source omission is
  destructive. The authoring file therefore requires the exact image read from the current Railway
  source after its match to the active successful deployment is verified. The guarded production
  helper refuses any `source` change in the plan, including type/image clearing. Other baseline drift
  such as restart policy or sleep settings may remain for separate review; the helper does not apply
  it. Apply only a separately reviewed and approved change.

The current live staging inventory has no Restate volume or mount even though the activation
definition declares one. Standby preserves volumes that exist; it never creates missing volumes.
Before staging activation, verify the volume and request-identity keypair are present and provision
the configured 500 MB volume plus matching identity if either is absent. Production's former Restate
volume was removed with the service; any future production runtime reactivation needs fresh
provisioning.

The catalog approval gate (#188) is declared here for control-api: production enables it with a fixed
cutover instant, staging keeps it disabled. Changing the cutover is a deliberate data-governance
decision; the operator procedure is in `docs/operations.md`.

Use the runbook in `docs/operations.md` for the complete activation, verification, and
return-to-standby sequence. Do not enable Railway Serverless as a substitute for no active
deployments: these long-lived services have not accepted its cold-start and connection semantics.

The former per-service `railway.json` and `railway.toml` Config as Code formats are deprecated and
must not be added.

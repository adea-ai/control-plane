# Railway infrastructure as code

`.railway/railway.ts` is the single Railway project definition for the Cloud profile. It owns
service sources, build/start commands, health checks, restart behavior, private endpoints, the
pinned Restate image, and the Restate volume attachment. Secret values use `preserve()` and remain
in Railway.

The TypeScript definition is the **activation profile** and deliberately declares one replica per
service. Railway's Infrastructure as Code schema rejects zero replicas, so the local-first MVP
standby baseline is owned by `infrastructure/railway/cost-policy.json` and applied with
`bun run railway:standby --environment <environment> --apply --confirm <environment>`. The command
disconnects application sources and removes only active deployment revisions, preserving services,
configuration, and volumes. It also removes queued, building, initializing, or otherwise
reactivatable revisions so delayed provider work cannot restart compute after verification.
`railway config apply` is therefore an activation operation, not a routine standby reconciliation
command.

Link the Railway CLI to the intended project and environment, then run `railway config plan`. Review
the complete plan before applying it. Production and staging must be planned and applied separately;
never apply a staging plan to production. Production application sources are disconnected by the
definition so a push to `main` cannot silently enable compute. Destructive changes require explicit
confirmation.

### Running the plan locally

The IaC engine ships in the CLI and guards against an out-of-date CLI by shelling out to
`process.env._`, falling back to `railway` on `PATH`. `_` is the shell's last-argument variable, so in
an ordinary shell it points at whatever token came last — a directory, not the binary. The guard then
fails with a misleading `This version of railway/iac requires Railway CLI 5.42.1 or newer` even
though the installed CLI is current.

Point `_` at the binary for the invocation:

```sh
env _="$(command -v railway)" railway config plan
```

A stale CLI is the only reason to see that message, so check `railway --version` before concluding
anything else is wrong. `railway config plan` is read-only: it reconciles the authoring file against
the linked project and environment without changing either, and `--detailed-exit-code` exits 2 when
changes are pending for CI gating.

**The engine treats an omitted field as a deletion** (the CLI documents this as "omit=delete"), which
has two consequences this file must respect:

- Every variable that exists in a live environment must be declared here — as a literal, or as
  `preserve()` when the value is a secret or provider-owned. Omitting one deletes it. That is how the
  retired `COMMIT_SHA` service variables reconcile away, and it is why the production
  `MARKETPLACE_REGISTRY_*` variables are declared as preserved: undeclared, a production apply would
  have deleted the marketplace registry URL and token.
- Production image sources are owned by the container-promotion workflow, not by this file, so the
  production branch declares no `source`. A `config apply` against production therefore always
  reports `source.image → null` for the application services. Those entries are an artifact of the
  omit=delete rule, not a desired change: applying them disconnects the promoted digests until the
  next release reconnects them. Review production plans with `railway config plan` and apply only
  when the diff is limited to fields this file owns; single-field corrections (for example a
  `limitOverride` byte value) can go through the provider API without a full apply.

The catalog approval gate (#188) is declared here for control-api: production enables it with a fixed
cutover instant, staging keeps it disabled. Changing the cutover is a deliberate data-governance
decision; the operator procedure is in `docs/operations.md`.

Use the runbook in `docs/operations.md` for the complete activation, verification, and
return-to-standby sequence. Do not enable Railway Serverless as a substitute for no active
deployments: these long-lived services have not accepted its cold-start and connection semantics.

The former per-service `railway.json` and `railway.toml` Config as Code formats are deprecated and
must not be added.

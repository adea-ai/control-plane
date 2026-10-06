# Local and Hosted Simple operator setup

The normal launcher exposes graph publication and execution validation/acceptance, but those
operations require an existing published profile, skills and ProjectState. The packaged operator
command creates those initial records through the existing domain publication rules. It accepts one
profile and up to 32 skills, computes content digests, assigns workspace ownership and workspace-authorized skill provenance (the workspace ID is the
attributable owner reference, with authorized trust), and initializes
an empty ProjectState at revision zero. Publication and initial state commit in one SQLite
transaction. Exact replay returns the same references; conflicting ownership, content, version
numbers or initial state fails without partial writes. Existing state revisions are preserved.

A running deployment can instead initialize a project's revision-zero ProjectState through the
authenticated `project-state.initialize` route (see [ProjectState](project-state.md)). The two
paths do not share receipts: the route rejects a scope the command created as already
initialized, and the command accepts an existing revision zero only when it exactly matches its
own input (including `at`).

This command has database-owner authority. It creates no HTTP route, service credential, catalog
approval, context grant, tool tariff, provider credential or runtime binding. Configure those through
their existing operator procedures. Catalog approval, when enabled, still requires a separate
approved decision. Execution validation creates a ContextPackage through the configured authoring
authority; caller-supplied ContextPackages are not imported by this command.

Stop the Local process or Hosted Simple container and its children before using the command. Use
the same OS/container user that owns the data directory. The directory must be private (0700), the
existing `control-plane.sqlite` must be private (0600), and both must be owned by that user and must
not be symlinks. Start the normal launcher once to initialize a new data directory, then stop it.
The input must be an absolute path to a regular, non-symlink private file (0600), no larger than
256 KiB. Keep operator documents private; output contains references and digests only.

For an installed package or source checkout after building:

```sh
bun apps/local-control-plane/dist/operator-bootstrap-cli.js \
  --data-dir /absolute/private/control-plane-data \
  --input /absolute/private/operator-input.json
```

The same compiled command is included in the Hosted Simple image. Run a one-off container with
the normal image and private data/input mounts, selecting `bun` as its entrypoint and invoking
`/workspace/apps/local-control-plane/dist/operator-bootstrap-cli.js`. Keep the serving container
stopped, use its configured database owner, and mount the input read-only. Do not alter existing
data ownership to make a different user fit the command.

The JSON input has exactly these top-level fields:

| Field                      | Value                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `schemaVersion`            | `1`                                                                                                  |
| `workspaceId`, `projectId` | Actual canonical IDs for the intended scope                                                          |
| `at`                       | Canonical UTC timestamp used for initial creation and publication                                    |
| `profile`                  | Exactly `profileId`, `profileVersionId`, `displayName`, positive integer `version`, and `definition` |
| `skills`                   | Array of objects with exactly `skillId`, `skillVersionId`, `displayName`, `manifest`, and `content`  |

Use the existing [profile and skill schemas](profiles-and-skills.md). A skill manifest omits
`contentDigest`; the publication service computes it from validated content. The profile definition's
exact skill pins must name included skills and match those computed digests. No ownership field is
accepted from the input. Use stable IDs and the same timestamp for exact replay; changing immutable
records requires new IDs/versions through the normal publication lifecycle. The command refuses a
second published profile version number or skill semantic version, even under a different ID.

After setup, restart the normal launcher, publish the graph, validate through
`/v1/executions/validate` using authorized `contextInputs` and ProjectState revision zero, and accept
the resulting immutable plan through `/v1/executions/accept`. Supply the required caller identity and
API credential. Runtime capability/model restrictions, policy, approvals and tariff checks remain
in force. Successful setup alone is not execution, provider certification, or operational
backup/restore evidence; verify committed workflow, artifact, usage and replay invariants in the
selected Docker recovery drill.

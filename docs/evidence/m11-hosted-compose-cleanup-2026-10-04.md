# M11 Hosted Compose fixture ownership and cleanup

The existing M10 Hosted Compose CI step used a fixed project and fixture path,
installed its exit trap after key provisioning and permissions, suppressed
Compose teardown failures, and retained bind-mounted fixture data after success.
This was observed at base `031c1dfc5f6530877c9a7d6b00ea540d1933bb0c`. It is a
cleanup gap, not evidence of the reported local Docker disk-growth cause.

The CI workflow now calls a repository-owned Bash entry point. It creates one
exclusive temporary root with an ownership marker, records its project and path
before setup, uses a unique project on every Compose call, and installs cleanup
before creating resources. Exit, HUP, INT and TERM run teardown. After successful
project-scoped teardown, a dedicated helper verifies the direct runner-temp
child and matching marker, walks without following links, then removes the
fixture. Caller projects and data paths are never adopted.

Each Compose command has a 180-second limit and a five-second kill grace; HTTP
probes have a five-second request limit. Fixture removal has a 20-second limit.
Failed teardown retains the recorded fixture for reconciliation and fails CI;
an original setup/startup failure remains the primary exit code. No global prune,
caller volume deletion, Docker engine restart or credential/settings change is
introduced. The original readiness, role/migration, credential recreation and
dependency disruption checks are retained.

Eight actual Bash lifecycle regressions failed against the extracted original
script: successful/setup/startup cleanup, signal handling, teardown failure,
unique project ownership and invalid scope rejection. The repaired tests use
fake executable CLI boundaries plus the actual ownership/removal helper and
filesystem. They create one small fixture at a time, record each child before
waiting, bound and reap their child process group, and remove their outer fixture
in `finally`. The final focused run passed 12 cases and 60 assertions across lifecycle,
existing Hosted-contract and lane-inventory checks in 12.476s. Temporary cached
dependency links and fixture directories were removed. They do not invoke the local Docker engine or certify actual
Compose service behavior. Current-head remote CI must execute the updated script.

SIGKILL, daemon loss, runner loss and interrupted deletion can leave resources;
the recorded owner/path remain the reconciliation boundary. A directory lacking
its marker is retained rather than guessed to be owned. No disk reclamation,
monetary saving or full milestone acceptance is claimed. Full twelve-issue/114-item
M11 scope, terminal accounting, physical retention and frozen independent
acceptance remain open.

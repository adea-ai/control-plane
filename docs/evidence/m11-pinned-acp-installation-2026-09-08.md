# M11 pinned Codex ACP build

Run with Node 24 on macOS or Linux and existing parent directories. First build
the pinned native cancellation repair, then build ACP using that native artifact:

```sh
node scripts/install-m11-codex-native.mjs /absolute/new/native-installation /absolute/rust-toolchain/bin /absolute/test-tools/bin
node scripts/install-m11-codex-acp.mjs /absolute/new/acp-installation /absolute/new/native-installation
```

Both destinations must not exist. Neither installer overwrites an installation.
The native build requires Rust/Cargo 1.95.0, just 1.58.0, cargo-nextest 0.9.143,
Python 3 and the platform C/C++ build tools. Pass the actual Rust toolchain binary
directory, not a directory of rustup shims. Source, lock and patch hashes and tool
versions are checked. The release-tag lock normalization is hash-checked and does
not change external dependency versions. Tests run without retries; the native
executable uses the upstream release profile. Git/npm/Cargo use private build
state rather than caller credentials or Cargo configuration. Build commands have
bounded process-group lifetimes (up to one hour per native command).

The ACP installer verifies the native receipt and bytes before copying, then
verifies the copied bytes again before writing its manifest. Both installations
must remain owner-protected: the receipt detects unexpected artifact changes but
is not a signature or protection against an owner replacing both receipt and file.
Keep native source/build provenance alongside the ACP installation for audit.

For the ACP build,
It fetches the pinned upstream v1.7.0 commit, verifies the lockfile and reviewed
accounting patch hashes, applies the patch, installs locked dependencies with
lifecycle scripts disabled, runs upstream types and tests without retries, and
builds the executable. The result must match the previously native-tested bundle
SHA-256. Codex is locked to 0.148.0. Upstream license, source and dependency lock
remain alongside the build.

Git/npm receive a new private home and an explicit environment, not the caller's
provider credentials or Git/npm configuration. Each build command has a ten-minute
deadline; interruption or timeout stops its owned process group. Failed builds
remain in their reserved directory for inspection without an installation manifest.
Remove or move that exact failed directory only after confirming ownership.

`installation.json` records source, lock, patch, native dependency version, Node
version and executable digest. Its status is `built`, **not certified**. This build
step neither installs globally nor enables the Local launcher. It does not provide
native authentication, sandbox policy, or in-flight recovery. Existing pre-repair
ACP installations require rebuilding in a new directory; startup rejects their
missing patched-native receipt with `ACP_NATIVE_REBUILD_REQUIRED`.

A fresh Node 24.18.0 build passed 492 upstream tests with 26 explicit skips and
produced bundle SHA-256
`6c6da8939e3c5e835f939850451074b84359e0fddb87ab48872e2a68b9a94529`.
The skips are not native acceptance passes. The installed-runtime verification
and Local composition-root checks below are separate from the build.

## Installed native stdio verification

```sh
bun scripts/certify-m11-installed-acp.mjs /absolute/installation /absolute/node24
```

This explicit native lane validates the installation manifest and bundle, starts
the installed executable with a fresh HOME/CODEX_HOME and a loopback model fixture,
completes one prompt, closes the process, and loads the native session in a new
process. Both prompts must report exactly 11 input and 3 output tokens, with only
two model requests. It rejects native tool requests and does not use user provider
credentials. The model server, native processes and temporary state are cleaned up.

In the PR #434 three-request run, after those two requests, the lane selected `codex-acp` through the Local runtime
configuration and completes a third request using SQLite and real Restate. It
publishes the fixture profile, Skill and context inputs, accepts one execution,
checks one completed attempt and its 11/3 token result, and waits for the Restate
workflow to complete. The model endpoint verifies profile and Skill instructions
and the configured model. Deliberately conflicting native default model/provider
settings demonstrate that the explicit runtime route wins. This uses the Local
acceptance service, not the public HTTP bootstrap path.

The pre-repair isolated installation passed that three-request lane on Node 24.18.0. npm user and global
configuration are both isolated in the installer. The extended three-request lane
also passed, as did build, type checking, lint, formatting and all 1,263 repository
tests (1,064 unit, 127 E2E, 72 smoke). This is native process-restart, loaded-session
accounting and Local launcher completion evidence, not in-flight reattachment,
multi-call accounting, model quality or full milestone certification. See
`docs/local-deployment.md` for the explicit startup configuration. Native
authentication remains operator-owned; installation does not authenticate or
silently enable a runtime.

The current lane additionally uses the authenticated HTTP API and requires native
cancellation of a fourth, held model request, replay of a lost cancellation ACK,
and provider-stream closure before cleanup with server idle timeout disabled.
See `docs/evidence/m11-acp-native-cancellation-2026-09-08.md` for current native
repair evidence and outstanding promotion gates. Historical three-request success
is not proof of this extended cancellation gate.

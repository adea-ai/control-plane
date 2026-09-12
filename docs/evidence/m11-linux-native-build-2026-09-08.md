# Linux native build verification

Status: partial, refreshed September 12. Linux release packaging and Local native
end-to-end verification passed. This is not hosted-runtime or full Milestone 11 acceptance.

## Verified inputs and completed checks

- Linux ARM64 Docker Engine 29.7.2 on the developer host, not a fresh VPS.
- Node 24.18.0 image digest
  `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
- Rust 1.95.0 image digest
  `sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1`.
- just 1.58.0 and cargo-nextest 0.9.143, commit `60fa45f63`, built and version-checked.
- Codex source `3ba0f711642a888aec92a611a3f3b2211157ff89`, cancellation patch and normalized
  lock verified against `pinnedCodexNativeBuild`. The complete source diff matches the
  pinned patch digest after excluding the independently hash-verified lock normalization.
- Native `codex-api` tests passed twice: 167 passed, zero skipped, retries disabled.
- Control Plane candidate `ebeec53ec2592a5d305cd62c77ed263b9763c858`: all 41 packages built
  on Linux with no cached build outputs. Frozen installation resolved 206 packages.
- All 1,267 Control Plane tests passed on Linux: 1,066 unit, 127 E2E, 74 smoke.
  Coverage: 87.08% lines and 84.64% functions, above the 80% gates.
- The real Restate 1.7.8 executable was version-checked from its Local app workspace.

The initial source-only archive lacked Git metadata. The first full-suite attempt failed
four smoke assertions and cancelled other groups. Adding HEAD history fixed the benchmark;
three historical-audit assertions still failed because two audit candidates are not HEAD
ancestors. Importing those exact commit objects restored the complete verification context.
The unchanged full suite then passed. No assertion or provenance check was disabled.

## Release build recovery

The build container runs as a non-root user, with no host mounts, no Docker socket, all Linux
capabilities dropped, no-new-privileges, a 1,024 PID limit and four CPUs. Its dependency-download
network is enabled. These are build-environment controls, not proof of native tool isolation.

Four concurrent Cargo compiler jobs exceeded the initial 10 GiB memory limit and `codex-core`
was OOM-killed. Increasing the limit to 12 GiB raced that failure; the original installer was
allowed to settle with Cargo exit 101 before recovery began. The compiled artifacts were kept.

Recovery verifies the source commit, complete patch, absence of unrelated untracked source,
normalized lock and exact tools before rerunning native tests and compiling with one Cargo job.
Source, dependencies, optimization, release profile and bundled sandbox code are unchanged.
The recovery created its receipt after binary version and digest checks. On September 12,
the retained binary reported `codex-cli 0.148.0` and its SHA-256 matched the receipt:
`0aa6958eaf97c24042d81c9b524c3383b9d03b94f5a43929f2ae7f8481788ddd`.
However, the debug-bearing Linux release executable is 1,247,158,784 bytes, exceeding the
native verifier's 512 MiB limit. The ACP installer rejected it with
`CODEX_NATIVE_EXECUTABLE_INVALID` before creating an ACP installation.
The new packaging helper, using GNU objcopy (GNU Binutils for Debian) 2.40, preserves
the original and a separate 1,027,766,512-byte debug symbol file. The executable with
debug information removed is 289,739,768 bytes and passes the existing native verifier.
Its SHA-256 is `60c4d97f883789c2ef3ba7fcb6b9164320d87c424191afc98dcaf68bb5c27196`.
No native verifier size limit was increased.
Linux requires `libcap-dev` for the bundled bubblewrap build; that build was not disabled.

The fresh installer now defaults Linux to one compiler job while retaining four on macOS.
This reduces concurrent compiler pressure; it is not a guaranteed memory-sizing claim.

## Packaged native verification

The first ACP upstream test run failed
two cases and then encountered an IPC error; retained native test processes and process-limit
events motivated an unchanged rerun with a bounded 4,096-process container limit rather than
1,024. The unchanged rerun passed types, 492 tests (26 upstream skips), bundle hashing, and
copied-native verification. The cgroup process-limit event counter did not increase during
the successful run. The failed run's remaining owned process group was terminated.

All 41 Control Plane packages at `be2abe1b892e4ee2191098d20b297674d59376ec` built in a
separate Linux source tree. `certify-m11-installed-acp.mjs` passed against the packaged
native binary and pinned ACP installation. It exercised real native session reload,
authenticated Local HTTP completion, cancellation with lost-ACK replay and provider-stream
closure before cleanup, and two permission-gated marker writes with lost-ACK replay.
Usage was 11 input / 3 output tokens for each completion and 33 input / 9 output tokens
for the approved execution, with one attempt per Local execution. The model endpoint is
a deterministic local fixture, not a live billable provider.

The host suite for the packaging changes passed 1,276 tests: 1,071 unit, 127 E2E, 78 smoke.
Types, lint and formatting passed. Packaging unit tests use a mocked transformation;
the Linux executable and native certification above provide the real artifact evidence.

## Remaining gates

Re-run publication checks against the final merged candidate and separately prove the
fresh one-command Linux build including packaging (this verification reused the retained,
hash-checked compiler output after its earlier build recovery).
Then separately prove Linux sandbox effects and recovery, real hosted RuntimeNode composition,
fresh-host deployment and the full M11 scenario matrix. Local tests and this build container
must not be substituted for those deployment requirements.

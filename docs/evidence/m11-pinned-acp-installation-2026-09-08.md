# M11 pinned Codex ACP build

Run with Node 24 on macOS or Linux and an existing parent directory:

```sh
node scripts/install-m11-codex-acp.mjs /absolute/new/installation
```

The destination must not exist. The installer never overwrites an installation.
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
native authentication, model routing, sandbox policy, or in-flight recovery.

A fresh Node 24.18.0 build passed 492 upstream tests with 26 explicit skips and
produced bundle SHA-256
`6c6da8939e3c5e835f939850451074b84359e0fddb87ab48872e2a68b9a94529`.
The skips are not native acceptance passes. Installed-runtime verification and
supported composition-root wiring remain required before promotion.

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

The isolated installation passed this lane on Node 24.18.0. npm user and global
configuration are both isolated in the installer. This is native process-restart
and loaded-session accounting evidence, not in-flight reattachment, multi-call
accounting, model quality, Local composition-root or full milestone certification.

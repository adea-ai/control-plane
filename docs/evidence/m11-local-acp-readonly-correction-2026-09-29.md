# M11 Local ACP read-only sandbox correction

## Finding

Local ACP sets `INITIAL_AGENT_MODE=read-only` in
`apps/local-control-plane/src/installed-acp-runtime.ts`. The pinned
`@agentclientprotocol/codex-acp` v1.7.0 source did not translate that ID to a
read-only filesystem policy: `AgentMode.ReadOnly` forwarded
`{ type: "workspaceWrite", writableRoots: [], networkAccess: false }` and the
`workspace-write` mode to Codex. The exact pinned Codex native build includes
the session `cwd` in the effective writable roots, so an attacker-influenced
task can cause workspace changes without leaving the operator-configured
working directory. Network access remained disabled; this finding does not
establish credential exposure or writes outside that workspace.

The earlier native-permission probe in
[`m11-native-acp-permission-2026-09-08.md`](m11-native-acp-permission-2026-09-08.md)
verified approval handling for its fixture command, but did not prove that
workspace writes were blocked by the selected mode.

## Remediation

The pinned ACP source patch now maps the existing `read-only` mode to Codex's
native `{ type: "readOnly", networkAccess: false }` sandbox and the
`read-only` sandbox mode. It retains `approvalPolicy: "on-request"` and
`approvalsReviewer: "user"`; the `agent` and `agent-full-access` modes are
unchanged. A new upstream regression test selects `INITIAL_AGENT_MODE` from
the environment and asserts that the exact read-only policy and approval
settings reach the Codex `turn/start` request.

The existing pinned-install manifest checks the patch and bundle digests. The
new bundle digest therefore rejects an older installed ACP build until it is
reinstalled through the pinned installer.

## Reproduction and verification

The reproduction used a clean clone of
`agentclientprotocol/codex-acp@2b48e9822330fc09f3a94a81563e5c4bb779601a`
(`v1.7.0`) and the repository patch
[`codex-acp-1.7.0-prompt-usage.patch`](fixtures/codex-acp-1.7.0-prompt-usage.patch).
That existing patch also contains the previously reviewed prompt-usage
correction.

- `git apply --unidiff-zero --check` against the exact upstream commit: passed.
- `npm ci --ignore-scripts --no-audit --no-fund`: passed.
- `npm run typecheck`: passed.
- `npx --no-install vitest run --no-file-parallelism --retry=0 src/__tests__/CodexACPAgent/CodexAcpClient.test.ts`: 99 passed.
- `npx --no-install vitest run --no-file-parallelism --retry=0`: 493 passed, 26 skipped across 51 files.
- `npm run build`: passed; `dist/index.js` SHA-256 is
  `af2f792e13bdbe671b55751ca2540eed803a21b7e1c5b1375d8aa1611099bc8a`.
- Control Plane `installed-acp-runtime.test.mjs`: 3 passed, including rejection
  of an installation manifest with the previous bundle digest;
  `acp-runtime.test.mjs`: 3 passed.
- Control Plane `bun run lint`, `bun run format:check`, and `git diff --check`:
  passed.

This proves the selected policy is the native read-only policy at the ACP
turn boundary; it does not attempt a filesystem write against the native
runtime. It is not a fresh deployed Railway, packaged Local, or Self-hosted
profile acceptance run. Those profile gates remain part of M11.5 and M11.3.

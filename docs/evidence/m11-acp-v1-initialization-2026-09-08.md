# ACP v1 initialization — partial M11.3 evidence

Base: `4d06dadf7befb3ac6898c1104a9fbd6d3c2f4142`. The candidate is the Git
commit containing this document. This change does not certify a native ACP agent.

## Observed failure and correction

`AcpDriver` previously sent `capabilities` and `info` even when explicitly
configured with `protocolVersion: 1`, and parsed only the v2 response shape.
A local transport probe returning v1 `agentCapabilities` and `agentInfo` produced
`ACP_INITIALIZATION_FAILED`. Two regression tests failed before the correction.

Explicit v1 configuration now sends `clientCapabilities` and `clientInfo` and
normalizes the v1 initialization response. Optional list/resume/close methods
require non-null advertised capability objects. Session loading additionally
requires native load advertisement and transport replay support. Malformed
capabilities and a different negotiated version fail closed. The default remains
v2; this is not automatic downgrade negotiation.

The wire shape was checked against the official
[v1 initialization specification](https://agentclientprotocol.com/protocol/v1/initialization)
and `agentclientprotocol/codex-acp` v1.7.0 source commit
`2b48e9822330fc09f3a94a81563e5c4bb779601a`, specifically
`src/CodexAcpServer.ts` initialization. That upstream release was published
2026-08-27. It is a proposed test target, not an installed or certified dependency.

## Validation and limits

The new initialization suite checks request fields, normalized metadata,
advertised/absent/null/malformed optional capabilities, version mismatch, and
the replay/load conjunction. Existing v2 adapter, external-session, and gateway
tests remain part of the package suite.

Verification: `bun test src` from `packages/acp-adapter` passed 51 tests and
179 assertions. Root lint, type-check, format-check, build, and test sequence
passed; the E2E group passed 101 tests and 571 assertions. Lint retains existing
warnings. The initial root-level package test filter matched no files; the
regression was then correctly run from the package directory before fixing it.

`AcpTransport` remains a normalized transport boundary, not a native stdio client.
This patch adds neither process spawning nor native v1 update/permission/prompt
completion translation. Those require a process transport, bounded lifecycle
handling, and real pinned-agent tests before any runtime certification changes.
No credentials, global packages, lockfiles, or certification classifications were
changed. Handshake unit tests do not prove prompts, tools, approvals, cancellation,
artifacts, usage, or restart recovery against the actual agent.

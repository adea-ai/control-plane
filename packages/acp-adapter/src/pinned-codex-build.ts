/** Immutable build identity shared by installation and Local launch verification. */
export const pinnedAcpBuild = Object.freeze({
  repository: 'https://github.com/agentclientprotocol/codex-acp.git',
  tag: 'v1.7.0',
  commit: '2b48e9822330fc09f3a94a81563e5c4bb779601a',
  lockSha256: 'f9ef6eb265b57fbd418b99726bf7aff59964f610d45775bea04ab00764107238',
  patchSha256: 'eb79b6b9a27b937a89b4942bf3be07d52698af1d55da79f1c77bc1bf626ea657',
  codexVersion: '0.148.0',
  bundleSha256: '6c6da8939e3c5e835f939850451074b84359e0fddb87ab48872e2a68b9a94529',
})

/** Native cancellation repair; platform binaries are built and recorded separately. */
export const pinnedCodexNativeBuild = Object.freeze({
  repository: 'https://github.com/openai/codex.git',
  tag: 'rust-v0.148.0',
  commit: '3ba0f711642a888aec92a611a3f3b2211157ff89',
  patchSha256: 'c05940a47ceb8562c644a06689e906b22b82583614984a878b95a8b3e6359efd',
  lockSha256: 'dc7e744faf19cb21ab1652a5b72555e43af3ddaf6f9882d156e036dd218bcd30',
  normalizedLockSha256: 'bc95b909a89c23633844ffcc1b7fbcfc6433c4dfd2c7b517d53b6e8516afbf85',
  rustVersion: 'rustc 1.95.0 (59807616e 2026-04-14)',
  cargoVersion: 'cargo 1.95.0 (f2d3ce0bd 2026-03-21)',
  justVersion: 'just 1.58.0',
  nextestVersion: 'cargo-nextest 0.9.143 (60fa45f63 2026-08-04)',
})

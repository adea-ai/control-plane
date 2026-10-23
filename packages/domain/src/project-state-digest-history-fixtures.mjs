/**
 * Frozen historical writer fixtures for the ProjectState mutation digest.
 *
 * These are NOT regenerated on the host that runs the tests. Every digest below was produced
 * by the VERBATIM #659 pre-change writer, extracted from the pre-change base
 * `6f56fca3581b8799e496fe575d7dca72a1dfcbaf` (`chore(main): release 1.32.9 (#658)`, the direct
 * parent of the #659 merge `97a861239`), and run against its own in-memory repository.
 *
 * The bytes are independent historical proof in the sense that they are witness bytes of the
 * historical writer, not a re-derivation by the current implementation: `canonicalBytes` is the
 * exact byte string the historical writer hashed, and `legacyDigest` is the digest it persisted.
 * `sha256(canonicalBytes) === legacyDigest` holds independently of any host, so the two frozen
 * values authenticate each other without a same-host regeneration.
 *
 * The historical writer's canonicalization sorts object keys with `String.prototype.localeCompare`
 * and no locale argument, so its output depends on the reader's ICU collation. The generation
 * profile below is therefore part of the provenance, and a reader whose collation differs may
 * not reproduce `legacyDigest` from `input`. That is exactly the ambiguity the versioned
 * record metadata removes for new records; these fixtures exist to keep the compatibility
 * window honest and bounded.
 *
 * Generation profile (recorded, not assumed):
 *   bun 1.4.2, ICU 78.1, resolved default locale en-US.
 *
 * See docs/project-state-digest-compatibility.md for the reader-first order, the supported
 * profiles, and the rollback and retained-data bounds.
 */

export const projectStateDigestHistoryFixtures = Object.freeze({
  schemaVersion: 1,
  provenance: Object.freeze({
    baseCommit: '6f56fca3581b8799e496fe575d7dca72a1dfcbaf',
    baseSubject: 'chore(main): release 1.32.9 (#658)',
    relation: 'direct parent of the #659 merge 97a861239',
    writer: 'the verbatim #659 pre-change packages/domain/src/project-state.ts writer',
    writerEntryPoint: 'ProjectStateService.applyMutation -> AppliedStateMutation.inputDigest',
    extraction:
      'git show 6f56fca3:packages/domain/src/project-state.ts, plus its own ' +
      'packages/contracts/src/identifiers.ts and packages/contracts/src/canonical-json.ts, ' +
      'run unmodified against the historical in-memory repository',
    generationProfile: Object.freeze({
      bun: '1.4.2',
      icu: '78.1',
      locale: 'en-US',
    }),
    regeneration:
      'never; the digests are frozen witness bytes of the historical writer and are not ' +
      're-derived by the current implementation on the test host',
  }),
  cases: Object.freeze([
    Object.freeze({
      name: 'free-form-keys-diverge-under-locale-collation',
      note:
        'The appended value is free-form JSON. The keys "a-b" and "a_b" order differently ' +
        'under locale collation than under code-point order, so the historical digest and the ' +
        'code-point digest genuinely diverge for this input.',
      input: Object.freeze({
        mutationId: 'stm_01JABCDEF0123456789ABCDEFG',
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
        projectId: 'prj_01JABCDEF0123456789ABCDEFG',
        expectedRevision: 0,
        actorPrincipalRef: 'principal://agent-hq/user/42',
        operations: Object.freeze([
          Object.freeze({
            kind: 'append',
            item: Object.freeze({
              itemId: 'psi_01JABCDEF0123456789ABCDEFG',
              key: 'goal',
              value: Object.freeze({ 'a-b': 1, a_b: 2 }),
              sensitivity: 'internal',
              freshness: Object.freeze({ observedAt: '2026-08-23T12:00:00.000Z' }),
              provenance: Object.freeze({
                sourceKind: 'principal',
                sourcePrincipalRef: 'principal://agent-hq/user/42',
                artifactRefs: Object.freeze([]),
                capturedAt: '2026-08-23T12:00:00.000Z',
              }),
            }),
          }),
        ]),
        at: '2026-08-23T13:00:00.000Z',
      }),
      legacyDigest: 'sha256:d0242104f627e6894978da6a8bb30862e358fa5b8537f37a52de7c87e895f466',
      canonicalBytes:
        '{"actorPrincipalRef":"principal://agent-hq/user/42","at":"2026-08-23T13:00:00.000Z","expectedRevision":0,"mutationId":"stm_01JABCDEF0123456789ABCDEFG","operations":[{"item":{"freshness":{"observedAt":"2026-08-23T12:00:00.000Z"},"itemId":"psi_01JABCDEF0123456789ABCDEFG","key":"goal","provenance":{"artifactRefs":[],"capturedAt":"2026-08-23T12:00:00.000Z","sourceKind":"principal","sourcePrincipalRef":"principal://agent-hq/user/42"},"sensitivity":"internal","value":{"a_b":2,"a-b":1}},"kind":"append"}],"projectId":"prj_01JABCDEF0123456789ABCDEFG","workspaceId":"wsp_01JABCDEF0123456789ABCDEFG"}',
      resultingRevision: 1,
      touchedItemIds: Object.freeze(['psi_01JABCDEF0123456789ABCDEFG']),
    }),
    Object.freeze({
      name: 'mixed-case-punctuation-and-nested-free-form-keys',
      note:
        'Mixed case, punctuation and a nested object and array, so the historical ' +
        'canonicalization is exercised on more than one key shape.',
      input: Object.freeze({
        mutationId: 'stm_01JBBCDEF0123456789ABCDEFG',
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
        projectId: 'prj_01JABCDEF0123456789ABCDEAA',
        expectedRevision: 0,
        actorPrincipalRef: 'principal://agent-hq/user/42',
        operations: Object.freeze([
          Object.freeze({
            kind: 'append',
            item: Object.freeze({
              itemId: 'psi_01JABCDEF0123456789ABCDEAA',
              key: 'plan',
              value: Object.freeze({
                'a-b': 1,
                ab: 2,
                a_b: 3,
                Aa: 4,
                'a!': 5,
                nested: Object.freeze({
                  'z-z': Object.freeze([1, 2]),
                  z_z: Object.freeze({ 'b-b': 6, b_b: 7 }),
                }),
              }),
              sensitivity: 'internal',
              freshness: Object.freeze({ observedAt: '2026-08-23T12:00:00.000Z' }),
              provenance: Object.freeze({
                sourceKind: 'principal',
                sourcePrincipalRef: 'principal://agent-hq/user/42',
                artifactRefs: Object.freeze([]),
                capturedAt: '2026-08-23T12:00:00.000Z',
              }),
            }),
          }),
        ]),
        at: '2026-08-23T13:00:00.000Z',
      }),
      legacyDigest: 'sha256:31077ee0f39a2a2408d4ffbab0769c97656c52f1e97146c781c9074fe34cf907',
      canonicalBytes:
        '{"actorPrincipalRef":"principal://agent-hq/user/42","at":"2026-08-23T13:00:00.000Z","expectedRevision":0,"mutationId":"stm_01JBBCDEF0123456789ABCDEFG","operations":[{"item":{"freshness":{"observedAt":"2026-08-23T12:00:00.000Z"},"itemId":"psi_01JABCDEF0123456789ABCDEAA","key":"plan","provenance":{"artifactRefs":[],"capturedAt":"2026-08-23T12:00:00.000Z","sourceKind":"principal","sourcePrincipalRef":"principal://agent-hq/user/42"},"sensitivity":"internal","value":{"a_b":3,"a-b":1,"a!":5,"Aa":4,"ab":2,"nested":{"z_z":{"b_b":7,"b-b":6},"z-z":[1,2]}}},"kind":"append"}],"projectId":"prj_01JABCDEF0123456789ABCDEAA","workspaceId":"wsp_01JABCDEF0123456789ABCDEFG"}',
      resultingRevision: 1,
      touchedItemIds: Object.freeze(['psi_01JABCDEF0123456789ABCDEAA']),
    }),
  ]),
})

export const projectStateDigestHistoryFixtureCases = projectStateDigestHistoryFixtures.cases

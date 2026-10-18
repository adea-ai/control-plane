import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalJsonStringify } from '@control-plane/domain'
import {
  assertPortableManifest,
  createPortableRecord,
  finalizePortableManifest,
  finalizeCanonicalPortableManifest,
  PORTABLE_CANONICAL_DIGEST_VERSION,
} from './manifest.ts'

const fixtures = ['pre-614', 'post-614'].map((epoch) =>
  JSON.parse(readFileSync(new URL(`./fixtures/manifest-${epoch}.json`, import.meta.url), 'utf8'))
)
const [before, after] = fixtures
const digest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
const unsigned = (manifest) => {
  const { contentDigest: _digest, ...input } = structuredClone(manifest)
  return input
}
const canonicalInput = () => ({
  ...unsigned(after.manifest),
  digestVersion: PORTABLE_CANONICAL_DIGEST_VERSION,
})

function legacyDigest(value) {
  const order = new Intl.Collator('en-US').compare
  const encode = (item) =>
    Array.isArray(item)
      ? `[${item.map(encode).join(',')}]`
      : item !== null && typeof item === 'object'
        ? `{${Object.entries(item)
            .toSorted(([a], [b]) => order(a, b))
            .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
            .join(',')}}`
        : JSON.stringify(item)
  return `sha256:${createHash('sha256').update(encode(value)).digest('hex')}`
}

describe('frozen historical portability manifests', () => {
  test('fixtures pin the historical complete and per-record digests across #614', () => {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/manifest-pre-614.json', import.meta.url)))
        .digest('hex')
    ).toBe('82c29b8d72fb5143d5945af3e89fb9bfdb16a6993e81efcc3235256bffa5a964')
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/manifest-post-614.json', import.meta.url)))
        .digest('hex')
    ).toBe('dec748c1d97adad1569b992a26e68d70d07f91fc3840544a050215a9776636a8')
    expect(before.sourceCommit).toBe('bb10f8e0569834ab9d5a65551868a4e0ff9c6810')
    expect(before.manifest.contentDigest).toBe(
      'sha256:ae156956c2dfb7a2b6c8246fc4dcb0b0f1580ab0885165a1cc6e82852a6156b2'
    )
    expect(after.manifest.contentDigest).toBe(
      'sha256:bcf16f8a878f4ec47d892be34a7e958589f6b360859eb3c1068f4cb5b498c781'
    )
    expect(before.manifest.records[0].contentDigest).toBe(
      'sha256:50c0d86293a6cad4da28a28b431f2a31ee1aa072a078bc3cb4206239bf49fa8a'
    )
    expect(after.manifest.records[0].contentDigest).toBe(
      'sha256:c3229b78f426c753b1ce91c0cc7268ce92106999dc8ec3dfffb30db31c8ddd45'
    )
  })

  for (const fixture of fixtures) {
    test(`${fixture.writerEpoch} verifies without changing retained identity, digest or array order`, () => {
      const snapshot = JSON.stringify(fixture.manifest)
      const result = assertPortableManifest(fixture.manifest)
      expect(result).toEqual(fixture.manifest)
      expect(JSON.stringify(fixture.manifest)).toBe(snapshot)
      expect(result.contentDigest).toBe(fixture.manifest.contentDigest)
      expect(result.records.map((record) => record.contentDigest)).toEqual(
        fixture.manifest.records.map((record) => record.contentDigest)
      )
    })
  }

  test('the historical epoch covers records as well as the whole manifest', () => {
    const mixed = structuredClone(before.manifest)
    mixed.records[0].contentDigest = after.manifest.records[0].contentDigest
    mixed.contentDigest = legacyDigest(unsigned(mixed))
    expect(() => assertPortableManifest(mixed)).toThrow('PORTABLE_RECORD_DIGEST_INVALID')
  })

  test('tamper, truncation, reorder and epoch substitution never silently rewrite a historical digest', () => {
    for (const fixture of fixtures) {
      for (const mutate of [
        (value) => {
          value.records[0].value['a_b'] = 99
        },
        (value) => {
          value.records.pop()
        },
        (value) => {
          value.records = value.records.toReversed()
        },
        (value) => {
          value.secretReferences[0].purpose = 'changed'
        },
        (value) => {
          value.contentDigest = 'sha256:' + '0'.repeat(64)
        },
      ]) {
        const changed = structuredClone(fixture.manifest)
        mutate(changed)
        expect(() => assertPortableManifest(changed)).toThrow('PORTABLE_MANIFEST_DIGEST_INVALID')
      }
    }
  })

  test('current unversioned exports keep their existing post-#614 bytes and shape', () => {
    const result = finalizePortableManifest(unsigned(after.manifest))
    expect(result).toEqual(after.manifest)
    expect(result).not.toHaveProperty('digestVersion')
    expect(
      createPortableRecord({
        category: 'policy-configuration',
        logicalId: after.manifest.records[0].logicalId,
        revision: 1,
        value: after.manifest.records[0].value,
      })
    ).toEqual(after.manifest.records[0])
  })
})

describe('explicit reader-first canonical portability digests', () => {
  test('the explicit version round-trips through JSON and includes its version in the digest', () => {
    const result = finalizeCanonicalPortableManifest(canonicalInput())
    expect(result.digestVersion).toBe('code-point-v2')
    expect(result.contentDigest).toBe(digest(unsigned(result)))
    expect(result.contentDigest).not.toBe(after.manifest.contentDigest)
    expect(assertPortableManifest(JSON.parse(JSON.stringify(result)))).toEqual(result)
  })

  test('new sorting is deterministic across permutations of records, references and object keys', () => {
    const first = canonicalInput()
    const second = structuredClone(first)
    second.records = second.records.toReversed()
    second.artifacts = second.artifacts.toReversed()
    second.secretReferences = second.secretReferences.toReversed()
    second.componentVersions = Object.fromEntries(
      Object.entries(second.componentVersions).toReversed()
    )
    second.compatibility.requiredCapabilities =
      second.compatibility.requiredCapabilities.toReversed()
    expect(finalizeCanonicalPortableManifest(second)).toEqual(
      finalizeCanonicalPortableManifest(first)
    )
    const result = finalizeCanonicalPortableManifest(first)
    expect(result.records.map((record) => record.logicalId)).toEqual(['Aa', 'a-b', 'a_b', 'ab'])
    expect(result.secretReferences.map((reference) => reference.key)).toEqual(['Aa', 'a-b', 'a_b'])
  })

  test('equal identity keys retain every value and have deterministic canonical tie-breaks', () => {
    const input = canonicalInput()
    const first = input.records[0]
    input.records.push(
      createPortableRecord({
        category: first.category,
        logicalId: first.logicalId,
        revision: first.revision,
        value: { alternative: true },
      })
    )
    input.secretReferences.push({ ...input.secretReferences[0], purpose: 'another-purpose' })
    input.artifacts.push({ ...input.artifacts[0], metadata: { alternate: 'metadata' } })
    const reversed = structuredClone(input)
    reversed.records = reversed.records.toReversed()
    reversed.secretReferences = reversed.secretReferences.toReversed()
    reversed.artifacts = reversed.artifacts.toReversed()
    expect(finalizeCanonicalPortableManifest(reversed)).toEqual(
      finalizeCanonicalPortableManifest(input)
    )
    expect(finalizeCanonicalPortableManifest(input).records).toHaveLength(input.records.length)
  })

  test('unknown, malformed and downgraded version claims cannot fall back to historical verification', () => {
    for (const version of [null, 1, {}, [], '', 'code-point-v1', 'code-point-v3']) {
      expect(() => assertPortableManifest({ ...after.manifest, digestVersion: version })).toThrow()
      expect(() =>
        finalizeCanonicalPortableManifest({ ...canonicalInput(), digestVersion: version })
      ).toThrow()
    }
    const explicit = finalizeCanonicalPortableManifest(canonicalInput())
    delete explicit.digestVersion
    expect(() => assertPortableManifest(explicit)).toThrow('PORTABLE_MANIFEST_DIGEST_INVALID')
    expect(() =>
      assertPortableManifest({
        ...after.manifest,
        digestVersion: PORTABLE_CANONICAL_DIGEST_VERSION,
      })
    ).toThrow('PORTABLE_MANIFEST_DIGEST_INVALID')
  })

  test('a new-format outer digest never authorizes legacy-epoch record digests', () => {
    const value = { ...unsigned(before.manifest), digestVersion: PORTABLE_CANONICAL_DIGEST_VERSION }
    const manifest = finalizeCanonicalPortableManifest(value)
    expect(() => assertPortableManifest(manifest)).toThrow('PORTABLE_RECORD_DIGEST_INVALID')
  })

  test('new-format record tamper fails even when the whole-manifest digest is recomputed', () => {
    const value = finalizeCanonicalPortableManifest(canonicalInput())
    value.records[0].value['a_b'] = 99
    value.contentDigest = digest(unsigned(value))
    expect(() => assertPortableManifest(value)).toThrow('PORTABLE_RECORD_DIGEST_INVALID')
  })
})

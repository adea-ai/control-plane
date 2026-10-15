/**
 * Deterministic JSON serialization ("canonical JSON") for content digests,
 * idempotency keys, fingerprints and structural equality checks.
 *
 * Pinned semantics:
 *
 * - Object entries are sorted by key in CODE-POINT (UTF-16 code unit) order:
 *   `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`.
 *   NEVER use `String.prototype.localeCompare` for this ordering: it delegates
 *   to ICU and is locale- and ICU-version-dependent. Proven divergence fixture:
 *   the keys `['a-b', 'ab', 'a_b', 'Aa', 'a!']` order differently under
 *   `localeCompare` than under code-point comparison (ICU collation treats
 *   `-`/`_` as variable-weight punctuation), so the same object serializes to
 *   different bytes on different hosts and any digest, idempotency key or
 *   scope check derived from it can silently break across deployments.
 * - Object entries whose value is `undefined` are omitted (JSON.stringify
 *   parity).
 * - Arrays keep their order; `undefined` array elements serialize as `null`
 *   (JSON.stringify parity).
 * - Leaves serialize exactly like `JSON.stringify`: finite numbers as JSON
 *   numbers, with `NaN`, `Infinity` and `-Infinity` mapped to `null`
 *   (JSON.stringify parity) and `-0` normalized to `0` (JSON.stringify parity).
 * - `undefined` at the document root serializes as `null`.
 * - `bigint`, function and symbol values throw `TypeError` (JSON.stringify
 *   parity for bigint; functions and symbols are likewise rejected instead of
 *   being silently dropped or coerced).
 * - Values must be JSON-compatible plain data: arrays, plain objects
 *   (prototype `Object.prototype` or `null`) and JSON leaves. Anything else
 *   (Date, Map, Set, class instances, ...) throws `TypeError` rather than
 *   serializing to a lossy or implementation-dependent form.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value)
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function serialize(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  const type = typeof value
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'number') {
    if (!Number.isFinite(value)) return 'null'
    return JSON.stringify(value)
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol')
    throw new TypeError(`canonicalJsonStringify: cannot serialize ${type} value`)
  if (Array.isArray(value)) {
    let output = '['
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) output += ','
      output += serialize(value[index])
    }
    return `${output}]`
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('canonicalJsonStringify: value is not JSON-compatible plain data')
  const record = value as Readonly<Record<string, unknown>>
  const keys = Object.keys(record).toSorted(compareCodePoint)
  let output = '{'
  let separator = ''
  for (const key of keys) {
    const entry = record[key]
    if (entry === undefined) continue
    output += `${separator}${JSON.stringify(key)}:${serialize(entry)}`
    separator = ','
  }
  return `${output}}`
}

/**
 * Deterministic key comparator: orders strings by Unicode code point,
 * independent of host locale/ICU. Use anywhere ordering feeds digests,
 * selection, or cross-host stability guarantees. Never use localeCompare
 * for these — its collation is locale-dependent (see the divergence fixture
 * in the tests: ['a-b','ab','a_b','Aa','a!']).
 */
export function compareCodePointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

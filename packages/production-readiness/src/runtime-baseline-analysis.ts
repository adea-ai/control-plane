import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const TEST_FILE_PATTERN = /\.test\.mjs$|\.test\.ts$|\.spec\.mjs$|\.spec\.ts$/
export const SOURCE_FILE_PATTERN = /\.ts$|\.mjs$/
const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g

/** Workspace npm scope; only `@control-plane/...` specifiers may match a layer. */
export const WORKSPACE_PACKAGE_SCOPE = '@control-plane/'

/**
 * Human-readable label for the coupling metric, exported so the report and
 * documentation can carry the same wording.
 */
export const COUPLING_METHOD =
  'static import heuristic (string match, no type resolution): @control-plane scope only, ' +
  'external @other-scope packages never match by basename, package directory mapped to its ' +
  'first-owning layer when one package spans multiple layers, relative .js/.ts spelling ' +
  'resolved, test files and self-edges excluded; not a compiler-resolved dependency graph'

/**
 * Bounded, safe failure reasons for exported baseline reports. Only an exact
 * existing reason code (A-Z0-9_, 2-64 chars) is preserved; anything else —
 * raw exception messages, paths, environment values, child output — collapses
 * to `UNCLASSIFIED_ERROR` so arbitrary content never reaches the export.
 */
export function safeFailureReason(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const code = /^\s*([A-Z][A-Z0-9_]{1,63})\s*$/.exec(message)?.[1]
  return code ?? 'UNCLASSIFIED_ERROR'
}

export interface ImportProbeChild {
  readonly error?: unknown
  readonly status?: number | null
  readonly stdout?: string | null
}

export type ImportProbeClassification =
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'measured'
      readonly importMs: number
      readonly rssBeforeBytes: number
      readonly rssAfterBytes: number
    }

/**
 * Classifies the raw result of a cold-import probe child process into bounded
 * report fields. Non-measured branches emit reason codes only: child stderr,
 * child stdout, and exception content are never copied into the report.
 */
export function classifyImportProbeChild(child: ImportProbeChild): ImportProbeClassification {
  if (child.error !== undefined && child.error !== null) {
    return { status: 'unavailable', reason: 'IMPORT_CHILD_SPAWN_FAILED' }
  }
  // A successful exit is required; stdout is never trusted on a nonzero or
  // signal-terminated exit, even when it contains valid-looking JSON.
  if ((child.status ?? 1) !== 0) {
    return { status: 'unavailable', reason: 'IMPORT_CHILD_EXITED' }
  }
  const stdout = (child.stdout ?? '').trim()
  if (stdout.length === 0) {
    return { status: 'unavailable', reason: 'IMPORT_OUTPUT_UNPARSEABLE' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.split('\n').at(-1) ?? '')
  } catch {
    return { status: 'unavailable', reason: 'IMPORT_OUTPUT_UNPARSEABLE' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'unavailable', reason: 'IMPORT_OUTPUT_UNPARSEABLE' }
  }
  const record = parsed as Record<string, unknown>
  if (record['status'] !== 'measured') {
    return { status: 'unavailable', reason: safeFailureReason(record['reason']) }
  }
  const { importMs, rssBeforeBytes, rssAfterBytes } = record as {
    importMs?: unknown
    rssBeforeBytes?: unknown
    rssAfterBytes?: unknown
  }
  const measurements = [importMs, rssBeforeBytes, rssAfterBytes]
  if (
    !measurements.every(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    )
  ) {
    return { status: 'unavailable', reason: 'IMPORT_OUTPUT_INVALID' }
  }
  return {
    status: 'measured',
    importMs: importMs as number,
    rssBeforeBytes: rssBeforeBytes as number,
    rssAfterBytes: rssAfterBytes as number,
  }
}

function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = []
  for (const match of contents.matchAll(IMPORT_PATTERN)) {
    if (match[1] !== undefined) specifiers.push(match[1])
  }
  return specifiers
}

export interface CouplingAssignment {
  readonly id: string
  readonly files: readonly string[]
}

export interface CouplingEdges {
  readonly targets: Record<string, number>
  readonly total: number
}

/**
 * Counts cross-layer static import edges with an explicitly labeled heuristic
 * (see {@link COUPLING_METHOD}):
 * - `@control-plane/name[/subpath]` resolves against the package layer keyed by
 *   `name` (subpaths are stripped before lookup); external `@other-scope/...`
 *   specifiers are never matched by basename;
 * - relative specifiers resolve to the owned source file, including the
 *   TypeScript ESM `./x.js` -> `./x.ts` spelling;
 * - when one package's files span several layers, package-level edges are
 *   attributed to the first layer that owns a file of that package;
 * - test files and self-edges are excluded.
 */
export async function measureCoupling(
  assignments: readonly CouplingAssignment[],
  base: string
): Promise<Record<string, CouplingEdges>> {
  const fileLayer = new Map<string, string>()
  for (const { id, files } of assignments) {
    for (const file of files) fileLayer.set(join(base, file), id)
  }
  const packageLayer = new Map<string, string>()
  for (const { id, files } of assignments) {
    for (const file of files) {
      const packageName = file.match(/^(?:packages|apps)\/([^/]+)\//)?.[1]
      if (packageName !== undefined && !packageLayer.has(packageName)) {
        packageLayer.set(packageName, id)
      }
    }
  }
  const edges: Record<string, Record<string, number>> = {}
  for (const { id } of assignments) edges[id] = {}
  for (const { id, files } of assignments) {
    for (const file of files) {
      if (!SOURCE_FILE_PATTERN.test(file) || TEST_FILE_PATTERN.test(file)) continue
      const contents = await readFile(join(base, file), 'utf8')
      for (const specifier of importSpecifiers(contents)) {
        let target: string | undefined
        if (specifier.startsWith(WORKSPACE_PACKAGE_SCOPE)) {
          const parts = specifier.split('/')
          const packageName = parts[1]
          target = packageName === undefined ? undefined : packageLayer.get(packageName)
        } else if (specifier.startsWith('.')) {
          const resolved = resolve(base, file, '..', specifier)
          const candidates = [
            resolved,
            ...(resolved.endsWith('.js') ? [`${resolved.slice(0, -3)}.ts`] : []),
            `${resolved}.ts`,
            `${resolved}.mjs`,
          ]
          for (const candidate of candidates) {
            const owner = fileLayer.get(candidate)
            if (owner !== undefined) {
              target = owner
              break
            }
          }
        }
        if (target !== undefined && target !== id) {
          const bucket = edges[id] ?? (edges[id] = {})
          bucket[target] = (bucket[target] ?? 0) + 1
        }
      }
    }
  }
  const result: Record<string, CouplingEdges> = {}
  for (const [id, targets] of Object.entries(edges)) {
    const total = Object.values(targets).reduce((sum, count) => sum + count, 0)
    result[id] = { targets, total }
  }
  return result
}

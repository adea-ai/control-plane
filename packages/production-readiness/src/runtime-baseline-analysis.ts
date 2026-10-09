import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const TEST_FILE_PATTERN = /\.test\.mjs$|\.test\.ts$|\.spec\.mjs$|\.spec\.ts$/
export const SOURCE_FILE_PATTERN = /\.ts$|\.mjs$/
const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g

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
  const stdout = (child.stdout ?? '').trim()
  if ((child.status ?? 1) !== 0 && stdout.length === 0) {
    return { status: 'unavailable', reason: 'IMPORT_CHILD_EXITED' }
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
  if (
    typeof importMs !== 'number' ||
    typeof rssBeforeBytes !== 'number' ||
    typeof rssAfterBytes !== 'number'
  ) {
    return { status: 'unavailable', reason: 'IMPORT_OUTPUT_INVALID' }
  }
  return { status: 'measured', importMs, rssBeforeBytes, rssAfterBytes }
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
 * Counts cross-layer static import edges exactly:
 * - `@scope/name[/subpath]` resolves against the package layer keyed by
 *   `name` (subpaths are stripped before lookup);
 * - relative specifiers resolve to the owned source file, including the
 *   TypeScript ESM `./x.js` -> `./x.ts` spelling;
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
        if (specifier.startsWith('@')) {
          const parts = specifier.split('/')
          const scope = parts[0]
          const packageName = scope !== undefined && scope.startsWith('@') ? parts[1] : parts[0]
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

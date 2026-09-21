import { readdir, readFile } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import process from 'node:process'

const repositoryRoot = new URL('..', import.meta.url)
const scanRoots = ['packages', 'apps', 'scripts']
const scanExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs'])

// Files carrying this marker are tracked in issue #612: their localeCompare
// ordering feeds persisted digests/fingerprints and needs a digest-versioned
// migration, not an in-place swap. Every other site must use
// compareCodePointOrder from @control-plane/contracts (or plain `<`/`>`).
const documentedSiteMarker = 'CANONICAL-JSON:'
const localeCompareCall = /\.localeCompare\s*\(/g

async function* walk(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* walk(path)
    } else if (scanExtensions.has(extname(entry.name))) {
      yield path
    }
  }
}

export function isDocumentedSite(content) {
  return content.includes(documentedSiteMarker)
}

export function findLocaleCompareCalls(content) {
  return [...content.matchAll(localeCompareCall)].map(
    (match) => content.slice(0, match.index).split('\n').length
  )
}

export async function collectViolations(root = repositoryRoot.pathname) {
  const violations = []
  for (const scanRoot of scanRoots) {
    for await (const path of walk(join(root, scanRoot))) {
      if (path.endsWith('.test.mjs') || path.includes('.test.')) continue
      const content = await readFile(path, 'utf8')
      if (isDocumentedSite(content)) continue
      for (const line of findLocaleCompareCalls(content)) {
        violations.push(`${relative(root, path)}:${line}`)
      }
    }
  }
  return violations
}

if (import.meta.main) {
  const violations = await collectViolations()
  if (violations.length > 0) {
    console.error(
      [
        'localeCompare must not be used for ordering that feeds digests, selection,',
        'or cross-host stability. Use compareCodePointOrder from @control-plane/contracts.',
        '',
        ...violations.map((violation) => `  ${violation}`),
        '',
        'If this site feeds a persisted digest or fingerprint, add a',
        `  ${documentedSiteMarker}`,
        '  marker documenting the blocker (tracked in #612) so the guard can allowlist it.',
      ].join('\n')
    )
    process.exitCode = 1
  } else {
    console.log('canonical ordering check passed: no undocumented localeCompare call sites')
  }
}

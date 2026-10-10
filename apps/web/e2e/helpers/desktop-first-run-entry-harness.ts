import { resolve } from 'node:path'

export const DESKTOP_FIRST_RUN_ENTRY_HARNESS_PATH = '/__adea-desktop-first-run-entry-harness'

export function desktopFirstRunEntryHarnessHtml(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>first-run entry harness</title>',
    '<style>html, body { margin: 0; min-height: 100%; } #harness-root { min-height: 100vh; }</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

export function desktopFirstRunEntryHarnessModuleSource(): string {
  const harnessPath = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/desktop-first-run-entry-harness-app.tsx'
  )
  if (!harnessPath.startsWith(process.cwd()))
    throw new Error('harness path escaped repository root')
  return `import '${'/@fs' + harnessPath}'`
}

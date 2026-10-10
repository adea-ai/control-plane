import { resolve } from 'node:path'

export const WORKSPACE_LEAD_SETUP_HARNESS_PATH = '/__adea-workspace-lead-setup-harness'

export function workspaceLeadSetupHarnessHtml(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>workspace lead harness</title>',
    '<style>html, body { margin: 0; min-height: 100%; } #harness-root { min-height: 100vh; }</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

export function workspaceLeadSetupHarnessModuleSource(): string {
  const harnessPath = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/workspace-lead-setup-harness-app.tsx'
  )
  if (!harnessPath.startsWith(process.cwd()))
    throw new Error('harness path escaped repository root')
  return `import '${'/@fs' + harnessPath}'`
}

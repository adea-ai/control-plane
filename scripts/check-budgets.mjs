import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const budgetFile = resolveBudgetFile()
const usage = 'usage: check-budgets.mjs [lane --group <unit|e2e|smoke> --seconds <n> | dist | deps]'

function resolveBudgetFile() {
  if (process.env.BUDGETS_FILE !== undefined) return process.env.BUDGETS_FILE
  return new URL('../budgets.json', import.meta.url)
}

export function parseBudgets(raw) {
  const budgets = JSON.parse(raw)
  if (budgets.schemaVersion !== 1)
    throw new Error(`unsupported budgets schemaVersion: ${String(budgets.schemaVersion)}`)
  return budgets
}

export function checkLaneBudget(budgets, group, measuredSeconds) {
  const lane = budgets.lanes?.[group]
  if (lane === undefined) throw new Error(`no lane budget for group: ${group}`)
  return {
    ok: measuredSeconds <= lane.ceilingSeconds,
    ceiling: lane.ceilingSeconds,
    baseline: lane.baselineSeconds,
    measured: measuredSeconds,
  }
}

async function totalDistBytes() {
  let total = 0
  for (const sourceRoot of ['packages', 'apps']) {
    const root = new URL(`../${sourceRoot}/`, import.meta.url)
    let entries
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const result = spawnSync('du', ['-sk', new URL(`${entry}/dist/`, root).pathname], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
      if (result.status === 0) {
        total += Number.parseInt(result.stdout.split('\t')[0] ?? '0', 10)
      }
    }
  }
  return total * 1024
}

export function checkDistBudget(budgets, totalBytes) {
  const ceilingBytes = budgets.dist.totalMbCeiling * 1024 * 1024
  return {
    ok: totalBytes <= ceilingBytes,
    ceilingMb: budgets.dist.totalMbCeiling,
    measuredMb: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
  }
}

export function countExternalPackages(lsOutput) {
  const external = new Set()
  for (const line of lsOutput.split('\n')) {
    const match = line.match(/^(?:[│├└─\s]+)?([a-z@][^@\s]+)@(\S+)$/)
    if (match === null) continue
    if (match[1].startsWith('@control-plane/')) continue
    external.add(`${match[1]}@${match[2]}`)
  }
  return external.size
}

export function checkDependencyBudget(budgets, externalCount) {
  const ceiling = budgets.dependencies.externalPackageCeiling
  return {
    ok: externalCount <= ceiling,
    ceiling,
    measured: externalCount,
  }
}

function report(check) {
  const status = check.ok ? 'OK' : 'BUDGET EXCEEDED'
  console.log(`${status}: ${JSON.stringify(check)}`)
  if (!check.ok) process.exitCode = 1
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const budgets = parseBudgets(await readFile(budgetFile, 'utf8'))
  if (command === 'lane') {
    const group = args[args.indexOf('--group') + 1]
    const seconds = Number(args[args.indexOf('--seconds') + 1])
    if (group === undefined || !Number.isFinite(seconds)) {
      console.error(usage)
      process.exitCode = 2
    } else {
      report(checkLaneBudget(budgets, group, seconds))
    }
  } else if (command === 'dist') {
    report(checkDistBudget(budgets, await totalDistBytes()))
  } else if (command === 'deps') {
    const result = spawnSync('bun', ['pm', 'ls', '--all'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    if (result.error !== undefined || result.status !== 0) {
      console.error('failed to enumerate dependencies via bun pm ls --all')
      process.exitCode = 1
    } else {
      report(checkDependencyBudget(budgets, countExternalPackages(result.stdout ?? '')))
    }
  } else {
    console.error(usage)
    process.exitCode = 2
  }
}

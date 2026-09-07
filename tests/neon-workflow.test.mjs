import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync(
  new URL('../.github/workflows/neon_workflow.yml', import.meta.url),
  'utf8'
)
const script = workflow.split("node <<'NODE'\n")[1]?.split('\n          NODE')[0]

function execute(overrides = {}) {
  const writes = []
  const masks = []
  const env = {
    DATABASE_HOST: 'direct.example.invalid',
    DATABASE_HOST_POOLED: 'pool.example.invalid',
    DATABASE_APP_PASSWORD: 'synthetic@app:password',
    DATABASE_MIGRATION_PASSWORD: 'synthetic/migration?password',
    GITHUB_ENV: '/synthetic/github-env',
    ...overrides,
  }
  runInNewContext(script, {
    URL,
    process: { env },
    require: (name) => {
      expect(name).toBe('node:fs')
      return { appendFileSync: (path, value) => writes.push({ path, value }) }
    },
    console: { log: (value) => masks.push(value) },
  })
  return { writes, masks }
}

describe('Neon restricted connection workflow', () => {
  test('exports distinct pooled and direct app connections without elevating their role', () => {
    expect(script).toBeString()
    const { writes, masks } = execute()
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('/synthetic/github-env')
    const values = Object.fromEntries(
      writes[0].value
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf('=')
          return [line.slice(0, split), line.slice(split + 1)]
        })
    )
    for (const [name, host, role, password] of [
      ['DATABASE_URL', 'pool.example.invalid', 'control_plane_app', 'synthetic@app:password'],
      [
        'DATABASE_URL_UNPOOLED',
        'direct.example.invalid',
        'control_plane_app',
        'synthetic@app:password',
      ],
      [
        'DATABASE_MIGRATION_URL',
        'direct.example.invalid',
        'control_plane_migrator',
        'synthetic/migration?password',
      ],
    ]) {
      const url = new URL(values[name])
      expect(url.hostname).toBe(host)
      expect(url.username).toBe(role)
      expect(decodeURIComponent(url.password)).toBe(password)
      expect(url.searchParams.get('sslmode')).toBe('require')
      expect(masks).toContain(`::add-mask::${values[name]}`)
    }
    expect(masks).toHaveLength(3)
  })

  test('fails closed when required connection inputs are absent', () => {
    for (const name of [
      'DATABASE_HOST',
      'DATABASE_HOST_POOLED',
      'DATABASE_APP_PASSWORD',
      'DATABASE_MIGRATION_PASSWORD',
      'GITHUB_ENV',
    ]) {
      expect(() => execute({ [name]: undefined })).toThrow(
        'Neon migration connection inputs are unavailable'
      )
    }
  })
})

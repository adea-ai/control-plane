import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync(
  new URL('../.github/workflows/neon_workflow.yml', import.meta.url),
  'utf8'
)
const script = workflow.split("node <<'NODE'\n")[1]?.split('\n          NODE')[0]
const cleanupScript = workflow.split("node <<'CLEANUP'\n")[1]?.split('\n          CLEANUP')[0]

async function findCleanupBranch(responses, overrides = {}) {
  const requests = []
  const writes = []
  let index = 0
  await runInNewContext(cleanupScript, {
    URL,
    AbortSignal,
    process: {
      env: {
        NEON_API_KEY: 'synthetic-key',
        NEON_PROJECT_ID: 'synthetic-project-123',
        PR_NUMBER: '404',
        PR_HEAD_REF: 'fix/example',
        GITHUB_OUTPUT: '/synthetic/output',
        ...overrides,
      },
    },
    require: () => ({ appendFileSync: (path, value) => writes.push({ path, value }) }),
    fetch: async (url, options) => {
      requests.push({ url: String(url), options })
      const response = responses[index++]
      if (response instanceof Error) throw response
      return { status: response.status ?? 200, json: async () => response.body }
    },
    console: { log: () => {} },
  })
  return { requests, writes }
}

const previewBranch = {
  id: 'br-synthetic-preview',
  name: 'preview/pr-404-fix/example',
  project_id: 'synthetic-project-123',
  parent_id: 'br-synthetic-parent',
  primary: false,
  default: false,
  protected: false,
}

describe('Neon preview cleanup lookup', () => {
  test('treats a successfully verified absent preview as a no-op', async () => {
    expect(cleanupScript).toBeString()
    const result = await findCleanupBranch([{ body: { branches: [] } }])
    expect(result.writes).toEqual([])
    expect(result.requests).toHaveLength(1)
    expect(workflow).toContain("if: steps.cleanup_branch.outputs.branch_id != ''")
    expect(workflow).toContain('branch: ${{ steps.cleanup_branch.outputs.branch_id }}')
  })

  test('matches the exact name across pagination and exports only a validated branch ID', async () => {
    const result = await findCleanupBranch([
      {
        body: {
          branches: [{ ...previewBranch, name: `${previewBranch.name}-other` }],
          pagination: { next: 'next/page' },
        },
      },
      { body: { branches: [previewBranch] } },
    ])
    expect(result.writes).toEqual([
      { path: '/synthetic/output', value: 'branch_id=br-synthetic-preview\n' },
    ])
    expect(new URL(result.requests[1].url).searchParams.get('cursor')).toBe('next/page')
    for (const request of result.requests) {
      expect(new URL(request.url).origin).toBe('https://console.neon.tech')
      expect(request.options.redirect).toBe('error')
      expect(request.options.headers.Authorization).toBe('Bearer synthetic-key')
    }
  })

  test('does not turn API failures or malformed listings into successful absence', async () => {
    for (const response of [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { status: 429 },
      { status: 500 },
      { body: {} },
      { body: { branches: [null] } },
      { body: { branches: [], pagination: { next: 1 } } },
      { body: { branches: [], pagination: 'invalid' } },
      new Error('synthetic network failure'),
    ]) {
      await expect(findCleanupBranch([response])).rejects.toThrow()
    }
  })

  test('rejects unsafe or ambiguous targets and pagination loops', async () => {
    for (const override of [
      { id: 'br-invalid\nother=output' },
      { project_id: 'another-project' },
      { parent_id: undefined },
      { primary: true },
      { default: true },
      { protected: true },
    ]) {
      await expect(
        findCleanupBranch([{ body: { branches: [{ ...previewBranch, ...override }] } }])
      ).rejects.toThrow()
    }
    await expect(
      findCleanupBranch([{ body: { branches: [previewBranch, previewBranch] } }])
    ).rejects.toThrow()
    await expect(
      findCleanupBranch([
        { body: { branches: [], pagination: { next: 'same' } } },
        { body: { branches: [], pagination: { next: 'same' } } },
      ])
    ).rejects.toThrow()
  })

  test('rejects missing credentials and malformed scope before fetching', async () => {
    for (const override of [
      { NEON_API_KEY: '' },
      { NEON_PROJECT_ID: '../other' },
      { PR_NUMBER: '0' },
      { PR_HEAD_REF: '' },
      { GITHUB_OUTPUT: '' },
    ]) {
      await expect(findCleanupBranch([], override)).rejects.toThrow(
        'Neon cleanup inputs are unavailable or invalid'
      )
    }
  })

  test('requires a complete listing even after finding a target', async () => {
    await expect(
      findCleanupBranch([
        { body: { branches: [previewBranch], pagination: { next: 'next' } } },
        { status: 500 },
      ])
    ).rejects.toThrow('Neon cleanup lookup failed: HTTP 500')
    await expect(
      findCleanupBranch(
        Array.from({ length: 20 }, (_, index) => ({
          body: { branches: [], pagination: { next: `page-${index}` } },
        }))
      )
    ).rejects.toThrow('Neon branch lookup exceeded pagination limit')
  })
})

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

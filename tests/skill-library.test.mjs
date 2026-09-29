import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSkillLibrary, validateSkillLibrary } from '../scripts/validate-skills.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

async function withSkillFixture(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-skill-library-'))
  const skillsRoot = join(root, '.agents', 'skills')
  const skillRoot = join(skillsRoot, 'example-skill')
  const owner = options.owner === undefined ? 'Control Plane maintainers' : options.owner
  const version = options.version === undefined ? '1.0.0' : options.version
  const registryOwner = options.registryOwner ?? owner ?? ''
  const registryVersion = options.registryVersion ?? version ?? ''
  const registryPurpose =
    options.registryPurpose ?? 'A focused example purpose for validation fixtures'
  const registryTrigger =
    options.registryTrigger ?? 'Use for fixture validation; NOT unrelated tasks'
  const metadata = [
    version === null ? '' : `  version: "${version}"`,
    owner === null ? '' : `  owner: "${owner}"`,
  ].filter(Boolean)
  const evidenceContract = `## Evidence contract

- **Inputs:** a fixture request.
- **Safe assumptions:** none beyond the fixture.
- **Allowed mutations:** none outside the fixture.
- **Outputs:** a validation result.
- **Verification commands:** focused validation.
- **Failure/skip reporting:** report each failed check.
- **Cleanup:** remove the fixture after the test.
- **Completion-claim guard:** do not claim completion without a clean result.`
  const skillText = `---
name: example-skill
metadata:
${metadata.join('\n')}
description: A fixture skill. Use when testing library validation behavior.
---

# Example Skill

${options.body ?? 'Read [the guide](references/guide.md) for this fixture.'}

${evidenceContract}
`
  const registry = `# Skill library registry

| Skill | Version | Purpose | Trigger boundary | Owner | Evidence contract |
| --- | --- | --- | --- | --- | --- |
| example-skill | ${registryVersion} | ${registryPurpose} | ${registryTrigger} | ${registryOwner} | [Evidence contract](./example-skill/SKILL.md#evidence-contract) |
`

  try {
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), skillText)
    await writeFile(join(skillsRoot, 'README.md'), registry)
    for (const [path, content] of Object.entries(
      options.resources ?? { 'references/guide.md': '# Guide\n' }
    )) {
      const target = join(skillRoot, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('M11.11 skill library baseline', () => {
  test('the committed inventory matches on-disk skills and metadata', async () => {
    const skills = await validateSkillLibrary()
    expect(skills.length).toBeGreaterThanOrEqual(9)
    for (const skill of skills) {
      expect(skill.files).toContain('SKILL.md')
      expect(skill.skillMdBytes).toBeGreaterThan(0)
      expect(skill.version).toMatch(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
      )
    }
  })

  test('every retained skill has a usable trigger description', async () => {
    const skills = await validateSkillLibrary()
    for (const skill of skills) {
      expect(skill.description.length, skill.name).toBeGreaterThanOrEqual(10)
    }
  })

  test('every retained skill documents a complete evidence contract', async () => {
    const skills = await validateSkillLibrary()
    for (const skill of skills) {
      const body = await readFile(
        join(repositoryRoot, '.agents', 'skills', skill.name, 'SKILL.md'),
        'utf8'
      )
      expect(/^## Evidence contract$/mu.test(body), skill.name).toBe(true)
      for (const field of [
        '**Inputs:**',
        '**Safe assumptions:**',
        '**Allowed mutations:**',
        '**Outputs:**',
        '**Verification commands:**',
        '**Failure/skip reporting:**',
        '**Cleanup:**',
        '**Completion-claim guard:**',
      ]) {
        expect(body, `${skill.name}: ${field}`).toContain(field)
      }
    }
  })

  test('rejects missing owners, invalid versions, and registry metadata drift', async () => {
    await withSkillFixture({ owner: null, version: 'one' }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      const messages = errors.map((error) => error.message).join('\n')
      expect(messages).toContain('metadata.owner is missing')
      expect(messages).toContain('metadata.version must be a semantic version')
    })

    await withSkillFixture({ registryOwner: 'Different owner' }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain('registry owner')
    })

    await withSkillFixture({ registryVersion: '2.0.0' }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain('registry version')
    })

    await withSkillFixture({ registryTrigger: 'too short' }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        'trigger boundary is missing or too short'
      )
    })
  })

  test('checks nested Markdown targets and rejects machine paths and credential-shaped content', async () => {
    await withSkillFixture(
      {
        body: 'Read [the guide](references/guide.md) and [private notes](references/private-notes.md).',
        resources: {
          'references/guide.md': '# Guide\n\n[missing](./missing.md)\n',
          'references/private-notes.md': `/Users/example/private\n${'ghp_' + 'A'.repeat(36)}\n`,
        },
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        const messages = errors.map((error) => error.message).join('\n')
        expect(messages).toContain('local Markdown link target')
        expect(messages).toContain('machine-specific absolute path')
        expect(messages).toContain('possible GitHub token')
      }
    )
  })

  test('keeps escaped and angle-bracket Markdown destinations intact', async () => {
    const escapedTarget = String.raw`references/not\)found.md`
    const unmatchedLabels = '['.repeat(4096)
    await withSkillFixture(
      {
        body: `${unmatchedLabels}\n${String.raw`Read [the guide](references/guide.md), [a file with spaces](<references/guide with spaces.md>), and [the escaped destination](${escapedTarget}).`}`,
        resources: {
          'references/guide.md': '# Guide\n',
          'references/guide with spaces.md': '# Guide with spaces\n',
        },
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors).toHaveLength(1)
        expect(errors[0].message).toContain(
          `local Markdown link target '${escapedTarget}' does not exist`
        )
      }
    )
  })

  test('scans malformed destinations without losing bracketed link labels', async () => {
    const malformedAngleDestinations = '[x](<'.repeat(4096)
    const malformedBareDestinations = '[x](a'.repeat(4096)
    const overlappingValidSuffix = '[x](a'.repeat(2048) + ')'
    const startedAt = performance.now()
    await withSkillFixture(
      {
        body: [
          malformedAngleDestinations,
          malformedBareDestinations,
          overlappingValidSuffix,
          '[link [foo [bar]]](references/nested-label-missing.md)',
          String.raw`[link \] label](references/escaped-close-missing.md)`,
          String.raw`[link \[bar](references/escaped-open-missing.md)`,
        ].join('\n'),
        resources: {},
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        const messages = errors.map((error) => error.message).join('\n')
        expect(messages).toContain('references/nested-label-missing.md')
        expect(messages).toContain('references/escaped-close-missing.md')
        expect(messages).toContain('references/escaped-open-missing.md')
      }
    )
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })

  test('rejects unreferenced nested resources', async () => {
    await withSkillFixture(
      {
        body: 'This fixture has no routed references.',
        resources: { 'references/orphan.md': '# Orphan\n' },
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors.map((error) => error.message).join('\n')).toContain('orphaned reference')
      }
    )
  })

  test('rejects a symlinked skill directory', async () => {
    await withSkillFixture({}, async (root) => {
      const skillsRoot = join(root, '.agents', 'skills')
      await symlink(join(skillsRoot, 'example-skill'), join(skillsRoot, 'linked-skill'), 'dir')
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        'skill directory is a symlink'
      )
    })
  })

  test('rejects a symlinked skills root and .agents ancestor', async () => {
    await withSkillFixture({}, async (root) => {
      const externalRoot = await mkdtemp(join(tmpdir(), 'control-plane-skill-library-external-'))
      try {
        const skillsRoot = join(root, '.agents', 'skills')
        const externalSkillsRoot = join(externalRoot, 'skills')
        await mkdir(externalSkillsRoot)
        await rm(skillsRoot, { recursive: true, force: true })
        await symlink(externalSkillsRoot, skillsRoot, 'dir')

        const skillsRootResult = await discoverSkillLibrary({ repositoryRoot: root })
        expect(skillsRootResult.errors.map((error) => error.message).join('\n')).toContain(
          '.agents/skills must be a real directory'
        )

        await rm(join(root, '.agents'), { recursive: true, force: true })
        const externalAgentsRoot = join(externalRoot, 'agents')
        await mkdir(join(externalAgentsRoot, 'skills'), { recursive: true })
        await symlink(externalAgentsRoot, join(root, '.agents'), 'dir')

        const agentsRootResult = await discoverSkillLibrary({ repositoryRoot: root })
        expect(agentsRootResult.errors.map((error) => error.message).join('\n')).toContain(
          '.agents must be a real directory'
        )
      } finally {
        await rm(externalRoot, { recursive: true, force: true })
      }
    })
  })

  test('rejects a symlinked skill registry', async () => {
    await withSkillFixture({}, async (root) => {
      const skillsRoot = join(root, '.agents', 'skills')
      const registryPath = join(skillsRoot, 'README.md')
      const registryTarget = join(root, 'registry-target.md')
      await writeFile(registryTarget, await readFile(registryPath, 'utf8'))
      await rm(registryPath)
      await symlink(registryTarget, registryPath, 'file')

      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        '.agents/skills/README.md must be a regular, non-symlink file'
      )
    })
  })

  test('treats a clear path instruction as routing to a nested reference', async () => {
    await withSkillFixture(
      {
        body: 'For advanced examples, read references/guide.md when the summary is insufficient.',
        resources: { 'references/guide.md': '# Guide\n' },
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors).toEqual([])
      }
    )
  })
})

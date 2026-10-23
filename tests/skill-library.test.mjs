import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSkillLibrary, validateSkillLibrary } from '../scripts/validate-skills.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

const BOUNDARY_LABELS = ['Secrets', 'Dirty worktree', 'Migration', 'Generated files', 'Provider']

const defaultBoundaries = {
  Secrets:
    'Never read, print, log, or commit real secrets; synthetic canaries only and a committed secret triggers rotation.',
  'Dirty worktree':
    'Preserve pre-existing and unrelated working-tree edits; never reset, stash, or discard them during a pass.',
  Migration:
    'Do not apply, revert, or generate database migrations; schema changes stay outside the pass and are reported only.',
  'Generated files':
    'Never hand-edit generated output; change the generator or the committed source that produces the artifact instead.',
  Provider:
    'Make no provider calls and activate no provider; provider-dependent work stays blocked with its prerequisite named.',
}

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
  const registryTrigger = options.registryTrigger ?? 'the fixture requests library validation'
  const trigger = options.trigger ?? 'the fixture requests library validation'
  const nontrigger = options.nontrigger ?? 'unrelated work that the fixture does not cover'
  const description =
    options.description ??
    `Use when ${trigger}. Not for ${nontrigger}. A focused example purpose for validation fixtures.`
  const metadata = [
    version === null ? '' : `  version: "${version}"`,
    owner === null ? '' : `  owner: "${owner}"`,
    options.provenance === null
      ? ''
      : '  provenance:\n    origin: repository-owned\n    integration_version: "1.0.0"',
    options.deprecated === true ? '  deprecated: true' : '',
    options.supersededBy === undefined ? '' : `  superseded_by: "${options.supersededBy}"`,
  ].filter(Boolean)
  const stopConditions =
    options.stopConditions ??
    'Stop and report when the fixture cannot be validated, and hand back the exact failing check.'
  const boundaries = options.boundaries ?? defaultBoundaries
  const boundarySection =
    options.boundarySection === null
      ? ''
      : `\n### Boundary contract\n\n${BOUNDARY_LABELS.map(
          (label) => `- **${label}:** ${boundaries[label] ?? defaultBoundaries[label]}`
        ).join('\n')}\n`
  const evidenceContract = `## Evidence contract

- **Inputs:** a fixture request.
- **Safe assumptions:** none beyond the fixture.
- **Allowed mutations:** none outside the fixture.
- **Outputs:** a validation result.
- **Verification commands:** focused validation.
- **Failure/skip reporting:** report each failed check.
${options.stopConditions === null ? '' : `- **Stop conditions:** ${stopConditions}\n`}- **Cleanup:** remove the fixture after the test.
- **Completion-claim guard:** do not claim completion without a clean result.${boundarySection}`
  const skillText = `---
name: example-skill
metadata:
${metadata.join('\n')}
description: ${options.rawDescription === true ? description : JSON.stringify(description)}
---

# Example Skill

${options.body ?? 'Read [the guide](references/guide.md) for this fixture.'}

${evidenceContract}
`
  const registry = `# Skill library registry

| Skill | Version | Purpose | Trigger | Non-trigger | Owner | Evidence contract |
| --- | --- | --- | --- | --- | --- | --- |
| example-skill | ${registryVersion} | ${registryPurpose} | ${registryTrigger} | ${registryNontrigger(options)} | ${registryOwner} | [Evidence contract](./example-skill/SKILL.md#evidence-contract) |
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
    // The published schema is part of the contract the validator enforces, so
    // a fixture carries the real one.
    const schema = await readFile(
      join(repositoryRoot, 'docs/skills/skill-library.schema.json'),
      'utf8'
    )
    await mkdir(join(root, 'docs', 'skills'), { recursive: true })
    await writeFile(join(root, 'docs', 'skills', 'skill-library.schema.json'), schema)
    if (options.ledger !== undefined) {
      await writeFile(join(root, 'docs', 'skills', 'provenance.md'), options.ledger)
    }
    if (options.inventory !== undefined) {
      await writeFile(join(root, 'docs', 'skills', 'skill-library.json'), options.inventory)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function registryNontrigger(options) {
  return options.registryNontrigger ?? 'unrelated work that the fixture does not cover'
}

/** A provenance ledger row for the fixture skill. */
function fixtureLedger({
  origin = 'repository-owned',
  upstreamSource = '—',
  upstreamVersion = '—',
  integrationVersion = '1.0.0',
  owner = 'Control Plane maintainers',
} = {}) {
  return `# Skill provenance ledger

## Ledger

| Skill | Origin | Upstream source | Upstream version | Local integration version | Accountable owner |
| --- | --- | --- | --- | --- | --- |
| example-skill | ${origin} | ${upstreamSource} | ${upstreamVersion} | ${integrationVersion} | ${owner} |
`
}

/**
 * Two-skill fixture used by the cross-skill uniqueness rules: routing clauses
 * and boundary values must be skill-specific across the whole library.
 */
async function withTwoSkillFixture(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-skill-library-dual-'))
  const skillsRoot = join(root, '.agents', 'skills')
  const names = ['example-skill', 'second-skill']
  const rows = []
  try {
    for (const [index, name] of names.entries()) {
      const trigger = options.triggers?.[index] ?? `the ${name} fixture requests library validation`
      const nontrigger =
        options.nontriggers?.[index] ?? `unrelated ${name} work the fixture does not cover`
      const boundaries = options.boundaries?.[index] ?? {
        ...defaultBoundaries,
        Secrets: `Never read, print, log, or commit real secrets while running ${name}; synthetic values only.`,
        'Dirty worktree': `Preserve pre-existing and unrelated working-tree edits during ${name}; never reset or stash them.`,
        Migration: `Do not apply, revert, or generate database migrations while running ${name}; report them only.`,
        'Generated files': `Never hand-edit generated output while running ${name}; change the generator instead.`,
        Provider: `Make no provider calls and activate no provider while running ${name}; name the prerequisite.`,
      }
      const skillText = `---
name: ${name}
metadata:
  version: "1.0.0"
  owner: "Control Plane maintainers"
  provenance:
    origin: repository-owned
description: ${JSON.stringify(`Use when ${trigger}. Not for ${nontrigger}. A focused example purpose for validation fixtures.`)}
---

# Example Skill

## Evidence contract

- **Inputs:** a fixture request.
- **Safe assumptions:** none beyond the fixture.
- **Allowed mutations:** none outside the fixture.
- **Outputs:** a validation result.
- **Verification commands:** focused validation.
- **Failure/skip reporting:** report each failed check.
- **Stop conditions:** Stop and report when the fixture cannot be validated, and hand back the exact failing check.
- **Cleanup:** remove the fixture after the test.
- **Completion-claim guard:** do not claim completion without a clean result.

### Boundary contract

${BOUNDARY_LABELS.map((label) => `- **${label}:** ${boundaries[label]}`).join('\n')}
`
      await mkdir(join(skillsRoot, name), { recursive: true })
      await writeFile(join(skillsRoot, name, 'SKILL.md'), skillText)
      rows.push(
        `| ${name} | 1.0.0 | A focused example purpose for the ${name} validation fixture | ${trigger} | ${nontrigger} | Control Plane maintainers | [Evidence contract](./${name}/SKILL.md#evidence-contract) |`
      )
    }
    await writeFile(
      join(skillsRoot, 'README.md'),
      `# Skill library registry\n\n| Skill | Version | Purpose | Trigger | Non-trigger | Owner | Evidence contract |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`
    )
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

describe('M11.11 skill routing, boundary, and lifecycle contracts', () => {
  test('rejects a description that does not follow the routing convention', async () => {
    await withSkillFixture(
      {
        description:
          'A fixture skill for testing library validation behavior without any routing clause.',
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors.map((error) => error.message).join('\n')).toContain('routing convention')
      }
    )
  })

  test('rejects a registry trigger that drifts from the skill description', async () => {
    await withSkillFixture(
      { registryTrigger: 'a completely different trigger clause' },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors.map((error) => error.message).join('\n')).toContain(
          'registry trigger boundary does not match'
        )
      }
    )
  })

  test('rejects a registry non-trigger that drifts from the skill description', async () => {
    await withSkillFixture(
      { registryNontrigger: 'a completely different non-trigger clause' },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors.map((error) => error.message).join('\n')).toContain(
          'registry non-trigger boundary does not match'
        )
      }
    )
  })

  test('rejects a missing stop condition in the evidence contract', async () => {
    await withSkillFixture({ stopConditions: null }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain('**Stop conditions:**')
    })
  })

  test('rejects a missing boundary contract and an incomplete boundary set', async () => {
    await withSkillFixture({ boundarySection: null }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain('### Boundary contract')
    })

    await withSkillFixture(
      {
        boundaries: { ...defaultBoundaries, Provider: 'short' },
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        const messages = errors.map((error) => error.message).join('\n')
        expect(messages).toContain('boundary contract "Provider" is missing or too short')
      }
    )
  })

  test('rejects missing or malformed provenance', async () => {
    await withSkillFixture({ provenance: null }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        'metadata.provenance is missing'
      )
    })
  })

  test('rejects a deprecated skill without a replacement', async () => {
    await withSkillFixture({ deprecated: true }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      const messages = errors.map((error) => error.message).join('\n')
      expect(messages).toContain('metadata.superseded_by naming its replacement')
      expect(messages).toContain('"> **Deprecated:**" notice')
    })
  })

  test('rejects a superseded_by pointer that names no retained skill', async () => {
    await withSkillFixture({ deprecated: true, supersededBy: 'missing-skill' }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        "metadata.superseded_by 'missing-skill' does not name a retained skill"
      )
    })
  })

  test('rejects a superseded_by pointer on a skill that is not deprecated', async () => {
    await withSkillFixture({ supersededBy: 'example-skill' }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        'metadata.superseded_by is only allowed on a deprecated skill'
      )
    })
  })

  test('rejects a provenance ledger that disagrees with the skill frontmatter', async () => {
    await withSkillFixture({ ledger: fixtureLedger({ owner: 'Someone Else' }) }, async (root) => {
      await expect(validateSkillLibrary({ repositoryRoot: root })).rejects.toThrow(
        /provenance ledger drifted/i
      )
    })
    await withSkillFixture(
      { ledger: fixtureLedger({ origin: 'vendored-upstream' }) },
      async (root) => {
        await expect(validateSkillLibrary({ repositoryRoot: root })).rejects.toThrow(
          /provenance ledger drifted/i
        )
      }
    )
  })

  test('rejects duplicate provenance rows, whether conflicting or identical', async () => {
    const duplicateLedgers = [
      `${fixtureLedger({ owner: 'Someone Else' })}\n${fixtureLedger()}`,
      `${fixtureLedger()}\n${fixtureLedger()}`,
    ]

    for (const ledger of duplicateLedgers) {
      await withSkillFixture({ ledger: fixtureLedger() }, async (root) => {
        await validateSkillLibrary({ repositoryRoot: root, refresh: true })
        await writeFile(join(root, 'docs', 'skills', 'provenance.md'), ledger)
        await expect(validateSkillLibrary({ repositoryRoot: root })).rejects.toThrow(
          /duplicate provenance ledger row/i
        )
      })
    }
  })

  test('accepts a provenance ledger that agrees with the skill frontmatter', async () => {
    await withSkillFixture({ ledger: fixtureLedger() }, async (root) => {
      await validateSkillLibrary({ repositoryRoot: root, refresh: true })
      const skills = await validateSkillLibrary({ repositoryRoot: root })
      expect(skills.map((skill) => skill.name)).toEqual(['example-skill'])
    })
  })

  test('rejects a manifest that does not satisfy the published schema', async () => {
    const inventory = JSON.stringify({
      schemaVersion: 1,
      skills: [
        {
          name: 'example-skill',
          description: 'A fixture skill. Use when testing library validation behavior.',
          version: '1.0.0',
          owner: 'Control Plane maintainers',
          // `trigger` is required by the published schema.
          nontrigger: 'unrelated work that the fixture does not cover',
          boundaries: {},
          stopConditions: 'Stop and report when the fixture cannot be validated.',
          cleanup: 'remove the fixture after the test',
          deprecated: false,
          provenance: { origin: 'repository-owned', integrationVersion: '1.0.0' },
          files: ['SKILL.md'],
          skillMdBytes: 1,
          skillMdDigest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    })
    await withSkillFixture({ ledger: fixtureLedger(), inventory }, async (root) => {
      await expect(validateSkillLibrary({ repositoryRoot: root })).rejects.toThrow(
        /does not satisfy/i
      )
    })
  })

  test('rejects a trigger clause that two skills share', async () => {
    await withTwoSkillFixture(
      {
        triggers: [
          'the fixture requests library validation',
          'the fixture requests library validation',
        ],
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors.map((error) => error.message).join('\n')).toContain(
          'routing trigger duplicates'
        )
      }
    )
  })

  test('rejects a routing clause that overlaps another skill clause', async () => {
    await withTwoSkillFixture(
      {
        triggers: [
          'the fixture requests library validation of the pinned library',
          'the fixture requests library validation',
        ],
      },
      async (root) => {
        const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
        expect(errors.map((error) => error.message).join('\n')).toContain(
          'routing trigger overlaps'
        )
      }
    )
  })

  test('rejects a boundary value that two skills share', async () => {
    const shared = { ...defaultBoundaries }
    await withTwoSkillFixture({ boundaries: [shared, { ...shared }] }, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors.map((error) => error.message).join('\n')).toContain(
        'boundary "Secrets" duplicates'
      )
    })
  })

  test('accepts two skills with distinct routing clauses and distinct boundaries', async () => {
    await withTwoSkillFixture({}, async (root) => {
      const { errors } = await discoverSkillLibrary({ repositoryRoot: root })
      expect(errors).toEqual([])
    })
  })
})

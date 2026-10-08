import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

// Each entry gets a fresh module graph: a preceding test import must not mask a cycle.
for (const entry of ['litellm-http', 'funding-view', 'file-recorded-funding', 'index']) {
  test(`fresh gateway import starts with ${entry}`, () => {
    const script = `
      import { strict as assert } from 'node:assert';
      await import(${JSON.stringify(new URL(`./${entry}.ts`, import.meta.url).href)});
      const http = await import(${JSON.stringify(new URL('./litellm-http.ts', import.meta.url).href)});
      const gateway = await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
      const funding = await import(${JSON.stringify(new URL('./funding-view.ts', import.meta.url).href)});
      const { decision } = await import(${JSON.stringify(new URL('./recorded-funding-fixtures.mjs', import.meta.url).href)});
      assert.equal(http.RecordedModelSpendingAuthorizationSchema, gateway.RecordedModelSpendingAuthorizationSchema);
      assert.equal(funding.RecordedModelFundingDecisionSchema.shape.grant, http.RecordedModelSpendingAuthorizationSchema);
      assert.equal(funding.RecordedModelFundingDecisionSchema.safeParse(decision).success, true);
      assert.equal(funding.RecordedModelFundingDecisionSchema.safeParse({...decision, unexpected: true}).success, false);
      assert.equal(http.RecordedModelSpendingAuthorizationSchema.safeParse({...decision.grant, unexpected: true}).success, false);
      assert.equal(http.RecordedModelSpendingAuthorizationSchema.safeParse({...decision.grant, fundingSource: 'unknown'}).success, false);
    `
    const result = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
      timeout: 5000,
    })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
}

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { expect, test } from 'bun:test'

// Resolve the actual Miniflare dependency edges rather than a separate test-only copy.
const miniflareRequire = createRequire(import.meta.resolve('miniflare'))

test('patched Miniflare image dependency retains native SVG decoding compatibility', () => {
  const script = `
    const assert = require('node:assert/strict');
    const sharp = require(process.argv[1]);
    assert.equal(sharp.versions.sharp, '0.35.5');
    (async () => {
      const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
      const output = await sharp(input).png().toBuffer();
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 1);
      assert.equal(metadata.height, 1);
      assert.equal(metadata.format, 'png');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync('node', ['-e', script, miniflareRequire.resolve('sharp')], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
  })
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})

test('patched transport preserves a custom BalancedPool connector and its rejection', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { BalancedPool } = require(process.argv[1]);
    let calls = 0;
    const pool = new BalancedPool('https://127.0.0.1:1', {
      connect(_options, callback) {
        calls++;
        callback(new Error('TEST_ONLY_CONNECTOR_REJECTION'));
      },
    });
    (async () => {
      try {
        await assert.rejects(pool.request({ path: '/', method: 'GET' }), /TEST_ONLY_CONNECTOR_REJECTION/);
        assert.equal(calls, 1);
      } finally {
        await pool.destroy();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync(
    'node',
    ['-e', script, dirname(miniflareRequire.resolve('undici/package.json'))],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseInventoryArgs, requestInventorySync } = require('../scripts/check-isend-inventory');

describe('inventory operator command', () => {
  it('defaults to preview and accepts multiple explicit SKUs', () => {
    expect(parseInventoryArgs(['--sku', 'A', '--sku', 'B'])).toEqual({ mode: 'preview', skus: ['A', 'B'] });
  });
  it('requires an explicit apply flag and reviewed hash for writes', () => {
    const hash = 'a'.repeat(64);
    expect(parseInventoryArgs(['--sku', 'A', '--apply', '--plan-hash', hash])).toEqual({ mode: 'apply', skus: ['A'], expectedPlanHash: hash });
  });
  it.each([[], ['--sku'], ['--sku', 'A', '--sku', 'A'], ['--env', 'production'], ['--force'], ['--sku', 'A', '--apply'], ['--sku', '--apply'], ['--sku', 'A', '--plan-hash', 'a'.repeat(64)]])('rejects unsafe/invalid arguments %j', (args) => {
    expect(() => parseInventoryArgs(args)).toThrow();
  });
  it('rejects unapproved destinations before sending the endpoint credential', () => {
    expect(() => requestInventorySync('https://unapproved.example', 'secret', {})).toThrow();
  });
});

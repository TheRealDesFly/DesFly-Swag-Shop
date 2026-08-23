import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = new URL('../.github/workflows', import.meta.url);

describe('iSend staging smoke workflow contract', () => {
  it('keeps GitHub Actions smoke workflows absent by local-first policy', () => {
    const workflowFiles = fs.existsSync(workflowsDir)
      ? fs.readdirSync(workflowsDir).filter((entry) => /\.(ya?ml)$/i.test(entry))
      : [];

    expect(workflowFiles).toEqual([]);
    expect(fs.existsSync(new URL('../.github/workflows/isend-staging-smoke.yml', import.meta.url)))
      .toBe(false);
  });

  it('does not leave workflow YAML elsewhere under .github', () => {
    const githubDir = new URL('../.github', import.meta.url);
    const found = [];

    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const current = path.join(dir.pathname, entry.name);
        if (entry.isDirectory()) {
          walk(current);
        } else if (/\.(ya?ml)$/i.test(entry.name)) {
          found.push(entry.name);
        }
      }
    }

    walk(githubDir);
    expect(found).toEqual([]);
  });
});

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/isend-staging-smoke.yml', import.meta.url),
  'utf8',
);

const activeLines = workflow.split(/\r?\n/).filter(
  (line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !/^#/.test(trimmed);
  },
);

describe('iSend staging smoke workflow contract', () => {
  it('stores workflow as YAML-valid local-first disabled config', () => {
    expect(activeLines).toHaveLength(3);
    expect(activeLines).toContain('name: iSend Staging Smoke Tests (disabled)');
    expect(activeLines).toContain('on: []');
    expect(activeLines).toContain('jobs: {}');
    expect(workflow).toContain('# name: iSend Staging Smoke Tests');
    expect(workflow).toContain('uses: actions/checkout@v4');
    expect(workflow).toContain('uses: actions/setup-node@v4');
  });

  it('asserts intentionally-disabled triggers and live-probe controls are inactive', () => {
    expect(workflow).toContain('on: []');
    expect(workflow).toContain('jobs: {}');
    expect(workflow).toContain('# on:');
    expect(workflow).toContain('# jobs:');
    expect(workflow).not.toMatch(/^[ \t]+on:/m);
    expect(workflow).not.toMatch(/^[ \t]+jobs:/m);
    expect(workflow).not.toMatch(/^[ \t]+concurrency:/m);
  });

  it('preserves the default-branch and Malaysia service-window release gates', () => {
    expect(workflow).toContain(
      "if: ${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
    );
    expect(workflow).toContain('expected_ref="refs/heads/${DEFAULT_BRANCH}"');
    expect(workflow).toContain('if [[ "$GITHUB_REF" != "$expected_ref" ]]');
    expect(workflow).toContain('if (( myt_hour >= 10 && myt_hour < 22 )); then');
    expect(workflow).toContain(
      "if: ${{ needs.service_window.outputs.within == 'true' }}",
    );
  });
});

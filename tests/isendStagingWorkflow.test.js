import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/isend-staging-smoke.yml', import.meta.url),
  'utf8',
);

const CHECKOUT_SHA = 'de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const SETUP_NODE_SHA = '48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';

describe('iSend staging smoke workflow contract', () => {
  it('pins every first-party action use to its verified immutable release commit', () => {
    const uses = Array.from(workflow.matchAll(
      /^[ \t]*uses:[ \t]+(actions\/(?:checkout|setup-node))@([0-9a-f]{40})[ \t]+#[ \t]+([^\r\n]+)$/gm,
    )).map((match) => ({
      action: match[1],
      sha: match[2],
      comment: match[3].trim(),
    }));

    expect(uses).toEqual([
      {
        action: 'actions/checkout',
        sha: CHECKOUT_SHA,
        comment: 'actions/checkout v6.0.2',
      },
      {
        action: 'actions/setup-node',
        sha: SETUP_NODE_SHA,
        comment: 'actions/setup-node v6.4.0',
      },
      {
        action: 'actions/checkout',
        sha: CHECKOUT_SHA,
        comment: 'actions/checkout v6.0.2',
      },
      {
        action: 'actions/setup-node',
        sha: SETUP_NODE_SHA,
        comment: 'actions/setup-node v6.4.0',
      },
    ]);
    expect(workflow).not.toMatch(
      /uses:[ \t]+actions\/(?:checkout|setup-node)@(?:v\d+|main|master)\b/,
    );
  });

  it('isolates serialized live probes from cancelable push and pull-request checks', () => {
    expect(workflow).toContain(
      "group: isend-staging-smoke-${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && 'live' || github.event_name }}-${{ github.ref }}",
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'push' || github.event_name == 'pull_request' }}",
    );
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

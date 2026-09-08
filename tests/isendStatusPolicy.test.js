import { describe, expect, it } from 'vitest';
import { evaluateISendStatusTransition, mapISendStatus } from '../src/backend/isendStatusPolicy';

describe('documented warehouse progress', () => {
  const stages = ['PROCESSING', 'ALLOCATING', 'ALLOCATED', 'PICKING', 'PICKED',
    'PACKING', 'PACKED', 'STAGING', 'STAGED', 'LOADING', 'LOADED', 'SHIPPED'];

  it('accepts the complete warehouse sequence without claiming delivery', () => {
    for (let index = 1; index < stages.length; index += 1) {
      expect(evaluateISendStatusTransition(stages[index - 1], stages[index]))
        .toMatchObject({ applied: true, effectiveStatus: stages[index] });
      expect(mapISendStatus(stages[index])).not.toBe('DELIVERED');
    }
  });

  it('ignores delayed allocation and packing after later progress', () => {
    expect(evaluateISendStatusTransition('PACKED', 'ALLOCATED'))
      .toMatchObject({ ignored: true, effectiveStatus: 'PACKED' });
    expect(evaluateISendStatusTransition('SHIPPED', 'LOADED'))
      .toMatchObject({ ignored: true, effectiveStatus: 'SHIPPED' });
  });

  it('preserves cancellation and delivery against delayed warehouse events', () => {
    for (const stage of stages) {
      expect(evaluateISendStatusTransition('CANCELLED', stage).effectiveStatus).toBe('CANCELLED');
      expect(evaluateISendStatusTransition('DELIVERED', stage).effectiveStatus).toBe('DELIVERED');
    }
  });

  it('requires review for a suspension instead of allowing fulfillment', () => {
    expect(() => evaluateISendStatusTransition('ALLOCATED', 'SUSPEND'))
      .toThrow('Unsupported iSend status');
  });
});

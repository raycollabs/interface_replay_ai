import { describe, expect, it } from 'vitest';
import { assembleOutput } from '../../src/replay/assembleOutput.js';
import type { OutputDef } from '../../src/contracts/index.js';

describe('assembleOutput', () => {
  it('assembles a scalar output from the matching extracted step', () => {
    const def: OutputDef = { shape: { type: 'decimal' }, description: 'x', sourceStepId: 'extract-balance' };
    expect(assembleOutput(def, { 'extract-balance': '4235.67' })).toBe('4235.67');
  });

  it('assembles an object output from multiple extracted steps into ONE structured value', () => {
    const def: OutputDef = {
      shape: { type: 'object', properties: { balance: { type: 'decimal' }, currency: { type: 'string' } } },
      description: 'x',
      sourceStepsByProperty: { balance: 'extract-balance', currency: 'extract-currency' },
    };
    const result = assembleOutput(def, { 'extract-balance': '4235.67', 'extract-currency': 'USD' });
    expect(result).toEqual({ balance: '4235.67', currency: 'USD' });
  });

  it('throws a clear error for array shapes -- no silent empty/wrong array', () => {
    const def: OutputDef = { shape: { type: 'array', items: { type: 'string' } }, description: 'x' };
    expect(() => assembleOutput(def, {})).toThrow(/no replay-time producer/);
  });
});

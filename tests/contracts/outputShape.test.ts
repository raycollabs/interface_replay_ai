import { describe, expect, it } from 'vitest';
import { OutputDefSchema } from '../../src/contracts/index.js';

describe('OutputDefSchema -- structured shapes, not flat type tags', () => {
  it('accepts a scalar output with sourceStepId', () => {
    const result = OutputDefSchema.safeParse({
      shape: { type: 'decimal' },
      description: 'A balance',
      sourceStepId: 'extract-balance',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a scalar output missing sourceStepId', () => {
    const result = OutputDefSchema.safeParse({ shape: { type: 'decimal' }, description: 'A balance' });
    expect(result.success).toBe(false);
  });

  it('accepts an object output whose sourceStepsByProperty covers every declared property', () => {
    const result = OutputDefSchema.safeParse({
      shape: {
        type: 'object',
        properties: { balance: { type: 'decimal' }, currency: { type: 'string' } },
      },
      description: 'An account',
      sourceStepsByProperty: { balance: 'extract-balance', currency: 'extract-currency' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an object output missing sourceStepsByProperty entirely', () => {
    const result = OutputDefSchema.safeParse({
      shape: { type: 'object', properties: { balance: { type: 'decimal' } } },
      description: 'An account',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an object output whose sourceStepsByProperty is missing an entry for a declared property', () => {
    const result = OutputDefSchema.safeParse({
      shape: {
        type: 'object',
        properties: { balance: { type: 'decimal' }, currency: { type: 'string' } },
      },
      description: 'An account',
      sourceStepsByProperty: { balance: 'extract-balance' }, // currency missing
    });
    expect(result.success).toBe(false);
  });

  it('accepts nested object shapes (an object property whose own shape is an object)', () => {
    const result = OutputDefSchema.safeParse({
      shape: {
        type: 'object',
        properties: {
          account: { type: 'object', properties: { balance: { type: 'decimal' } } },
        },
      },
      description: 'Wraps an account',
      sourceStepsByProperty: { account: 'extract-account' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a declared array shape at the schema level -- representable even though replay has no producer for it yet', () => {
    const result = OutputDefSchema.safeParse({
      shape: { type: 'array', items: { type: 'string' } },
      description: 'A list, not yet assembled by replay',
    });
    expect(result.success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CapabilityDefinitionSchema, TenantBindingSchema } from '../../src/contracts/index.js';
import { resolveCapability } from '../../src/multitenant/resolve.js';

function loadBase() {
  const path = fileURLToPath(new URL('../../capabilities/member.read-savings-balance.v2.json', import.meta.url));
  return CapabilityDefinitionSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

function loadBinding() {
  const path = fileURLToPath(new URL('../../tenants/credit-union-b.json', import.meta.url));
  return TenantBindingSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

describe('resolveCapability', () => {
  it('replaces scope.allowedOrigins with the binding entryUrl', () => {
    const { capability } = resolveCapability(loadBase(), loadBinding());
    expect(capability.scope.allowedOrigins).toEqual(['http://localhost:4174']);
  });

  it('overrides only the declared purposes, leaving everything else from the base capability untouched', () => {
    const base = loadBase();
    const { capability } = resolveCapability(base, loadBinding());

    expect(capability.targetRegistry['member identifier input']!.candidates[0]!.strategy).toEqual({
      type: 'associated_label',
      label: 'Customer Number',
    });
    expect(capability.targetRegistry['accounts navigation']!.candidates[0]!.strategy).toMatchObject({
      type: 'role_and_name',
      name: 'Products',
    });

    // Untouched purposes are identical to the base -- a binding narrows,
    // it does not silently affect anything it didn't declare.
    expect(capability.targetRegistry['account balance field']).toEqual(base.targetRegistry['account balance field']);
    expect(capability.steps).toEqual(base.steps);
    expect(capability.checkpoint).toEqual(base.checkpoint);
  });

  it('records the full resolution chain for audit', () => {
    const { resolvedFrom } = resolveCapability(loadBase(), loadBinding());
    expect(resolvedFrom).toHaveLength(2);
    expect(resolvedFrom[0]).toContain('member.read-savings-balance@2');
    expect(resolvedFrom[1]).toContain('credit-union-b');
  });

  it('refuses to resolve a binding against the wrong capability id/version', () => {
    const base = loadBase();
    const binding = loadBinding();
    expect(() => resolveCapability(base, { ...binding, baseCapabilityVersion: 999 })).toThrow(/targets/);
  });

  it('refuses a binding that overrides a purpose the base capability never declared', () => {
    const base = loadBase();
    const binding = loadBinding();
    const badBinding = {
      ...binding,
      targetOverrides: {
        ...binding.targetOverrides,
        'permission denied banner': { candidates: [{ strategy: { type: 'role_and_name' as const, role: 'alert', name: '', exact: false }, rationale: 'x', confidence: 'low' as const }] },
      },
    };
    expect(() => resolveCapability(base, badBinding)).toThrow(/does not declare/);
  });
});

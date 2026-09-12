import { describe, expect, it } from 'vitest';
import { canonicalizeRoute } from '../../src/compiler/canonicalize.js';

describe('canonicalizeRoute', () => {
  it('replaces a path segment that exactly matches an input value', () => {
    expect(canonicalizeRoute('http://localhost:4173/member/12345/accounts', { memberId: '12345' })).toBe(
      '/member/:memberId/accounts',
    );
  });

  it('handles multiple distinct input values in the same route', () => {
    expect(
      canonicalizeRoute('http://localhost:4173/tenant/acme/member/12345', { tenantSlug: 'acme', memberId: '12345' }),
    ).toBe('/tenant/:tenantSlug/member/:memberId');
  });

  it('leaves a route with no matching segment untouched', () => {
    expect(canonicalizeRoute('http://localhost:4173/member-search', { memberId: '12345' })).toBe('/member-search');
  });

  it('does not canonicalize a segment that merely resembles an id but is not a declared input value', () => {
    expect(canonicalizeRoute('http://localhost:4173/member/99999/accounts', { memberId: '12345' })).toBe(
      '/member/99999/accounts',
    );
  });

  it('ignores empty/undefined input values rather than replacing empty path segments', () => {
    expect(canonicalizeRoute('http://localhost:4173/member/12345', { memberId: '12345', note: '' })).toBe(
      '/member/:memberId',
    );
  });
});

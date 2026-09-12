import { describe, expect, it } from 'vitest';
import { evaluatePolicy, intersectWithCapabilityScope, type PolicyContext } from '../../src/policy/allowlist.js';

const baseCtx: PolicyContext = {
  allowlist: {
    allowedOrigins: ['http://localhost:4173'],
    allowedRoutes: ['/login', '/member-search', '/member/*'],
    allowedActionTypes: ['navigate', 'click', 'type', 'extract'],
    unattendedRiskCeiling: 'safe_reversible',
  },
  mode: 'UNATTENDED',
};

describe('evaluatePolicy', () => {
  it('allows an in-scope, allowlisted action', () => {
    const decision = evaluatePolicy(
      { actionType: 'navigate', targetUrl: 'http://localhost:4173/member-search', route: '/member-search', riskClass: 'read_only' },
      baseCtx,
    );
    expect(decision).toEqual({ decision: 'allow' });
  });

  it('denies an action type outside the allowlist', () => {
    const decision = evaluatePolicy({ actionType: 'select', route: '/member-search' }, baseCtx);
    expect(decision.decision).toBe('deny');
  });

  it('denies navigation to an out-of-allowlist origin -- the injection containment boundary', () => {
    const decision = evaluatePolicy(
      { actionType: 'navigate', targetUrl: 'https://evil.example.com/steal', route: '/steal' },
      baseCtx,
    );
    expect(decision.decision).toBe('deny');
  });

  it('denies a route not matching any allowlisted pattern', () => {
    const decision = evaluatePolicy({ actionType: 'click', route: '/admin/wire-transfer' }, baseCtx);
    expect(decision.decision).toBe('deny');
  });

  it('matches wildcard route patterns', () => {
    const decision = evaluatePolicy({ actionType: 'click', route: '/member/12345' }, baseCtx);
    expect(decision.decision).toBe('allow');
  });

  it('matches compiler-derived :name route patterns -- not just * wildcards', () => {
    const ctx: PolicyContext = { ...baseCtx, allowlist: { ...baseCtx.allowlist, allowedRoutes: ['/member/:memberId/accounts'] } };
    const decision = evaluatePolicy({ actionType: 'click', route: '/member/67890/accounts' }, ctx);
    expect(decision.decision).toBe('allow');
  });

  it(':name matches exactly one path segment, not a deeper path', () => {
    const ctx: PolicyContext = { ...baseCtx, allowlist: { ...baseCtx.allowlist, allowedRoutes: ['/member/:memberId'] } };
    const decision = evaluatePolicy({ actionType: 'click', route: '/member/12345/accounts' }, ctx);
    expect(decision.decision).toBe('deny');
  });

  it('requires human for risky_irreversible regardless of ceiling, even in ATTENDED mode is fine but UNATTENDED always escalates', () => {
    const decision = evaluatePolicy(
      { actionType: 'click', route: '/member/12345/accounts/new', riskClass: 'risky_irreversible' },
      baseCtx,
    );
    expect(decision.decision).toBe('require_human');
  });

  it('requires human when risk exceeds the unattended ceiling', () => {
    const decision = evaluatePolicy(
      { actionType: 'click', route: '/member/12345', riskClass: 'mutating_reversible' },
      baseCtx,
    );
    expect(decision.decision).toBe('require_human');
  });

  it('allows a risk class at or below the unattended ceiling', () => {
    const decision = evaluatePolicy(
      { actionType: 'click', route: '/member/12345', riskClass: 'safe_reversible' },
      baseCtx,
    );
    expect(decision.decision).toBe('allow');
  });

  it('ATTENDED mode does not apply the unattended ceiling to non-irreversible risk', () => {
    const decision = evaluatePolicy(
      { actionType: 'click', route: '/member/12345', riskClass: 'mutating_reversible' },
      { ...baseCtx, mode: 'ATTENDED' },
    );
    expect(decision.decision).toBe('allow');
  });

  it('ATTENDED mode still escalates risky_irreversible (attended = human present, not auto-approved)', () => {
    const decision = evaluatePolicy(
      { actionType: 'click', route: '/member/12345', riskClass: 'risky_irreversible' },
      { ...baseCtx, mode: 'ATTENDED' },
    );
    expect(decision.decision).toBe('require_human');
  });
});

describe('intersectWithCapabilityScope', () => {
  it('drops a tenant-allowlisted route the capability does not declare -- least privilege', () => {
    const tenantAllowlist = {
      allowedOrigins: ['http://localhost:4173'],
      allowedRoutes: ['/member/*', '/admin/wire-transfer'], // tenant permits more than this capability needs
      allowedActionTypes: ['navigate', 'click', 'type', 'extract'] as (
        | 'navigate'
        | 'click'
        | 'type'
        | 'extract'
      )[],
      unattendedRiskCeiling: 'safe_reversible' as const,
    };
    const capabilityScope = {
      allowedOrigins: ['http://localhost:4173'],
      allowedRoutes: ['/member/*'],
      allowedActionTypes: ['navigate', 'click', 'extract'],
    };
    const effective = intersectWithCapabilityScope(tenantAllowlist, capabilityScope);
    expect(effective.allowedRoutes).not.toContain('/admin/wire-transfer');
    expect(effective.allowedRoutes).toContain('/member/*');
    expect(effective.allowedActionTypes).not.toContain('type');
  });
});
